#!/usr/bin/env python3
"""Fail-closed Linux verification of explicitly frozen project inputs.

The project supplies file/directory inputs and a command. This supervisor is
host-owned; strace wraps bwrap, so the sandbox cannot edit its read trace.
"""
import argparse
import hashlib
import json
import os
import pwd
import posixpath
import stat
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time


OPEN = re.compile(r"=\s+\d+<([^<>]+)(?:<[^>]+>)?>(?:\(deleted\))?\s*$")


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def living_process_group(group):
    """Ignore reaped-but-uncollected zombies; they cannot execute or retain fds."""
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            fields = (proc / "stat").read_text().rsplit(") ", 1)[1].split()
            pgrp = int(fields[2])
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
            continue
        if pgrp == group and fields[0] != "Z":
            return True
    return False


def inventory(root, names):
    if not isinstance(names, list) or not names:
        raise ValueError("inputs must be a nonempty array")
    files = {}
    for name in names:
        if not isinstance(name, str) or not name or name.startswith("/") or ".." in Path(name).parts:
            raise ValueError("unsafe input path")
        target = root / name
        cursor = root
        for part in Path(name).parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ValueError("symlink input ancestor: " + name)
        if not target.exists() or target.is_symlink():
            raise ValueError("missing or symlink input: " + name)
        candidates = [target] if target.is_file() else sorted(target.rglob("*"))
        for candidate in candidates:
            relative = candidate.relative_to(root).as_posix()
            if candidate.is_symlink():
                raise ValueError("symlink input: " + relative)
            if candidate.is_file():
                files[relative] = {"sha256": sha(candidate), "size": candidate.stat().st_size,
                                   "mode": stat.S_IMODE(candidate.stat().st_mode)}
            elif not candidate.is_dir():
                raise ValueError("special input: " + relative)
    return dict(sorted(files.items()))


def decode_trace_string(value):
    """Decode strace C byte escapes, not JSON or Python Unicode escapes."""
    result = bytearray()
    escapes = {'a': 7, 'b': 8, 't': 9, 'n': 10, 'v': 11, 'f': 12,
               'r': 13, '\\': 92, '"': 34}
    i = 0
    while i < len(value):
        char = value[i]
        if char != '\\':
            result.extend(os.fsencode(char))
            i += 1
            continue
        i += 1
        if i >= len(value):
            raise ValueError('trailing escape')
        if value[i] in escapes:
            result.append(escapes[value[i]])
            i += 1
        elif value[i] in '01234567':
            match = re.match(r'[0-7]{1,3}', value[i:])
            result.append(int(match[0], 8))
            i += len(match[0])
        elif value[i] == 'x' and re.match(r'[0-9a-fA-F]{2}', value[i + 1:]):
            result.append(int(value[i + 1:i + 3], 16))
            i += 3
        else:
            raise ValueError('unknown escape')
    if 0 in result:
        raise ValueError('NUL path')
    return os.fsdecode(bytes(result))


def available_project_attempt(raw_name, root, runtime_files):
    """Walk in the sandbox namespace before mapping /work to the source.

    Do not normalize away missing or non-directory ancestors. In particular,
    /work/../work re-enters the same mount, not a host sibling named work.
    Linux treats any number of leading slashes as the same root.
    """
    virtual_dirs = {'/home', '/tmp', '/out', '/proc', '/dev'}
    for name in runtime_files:
        virtual_dirs.update(str(parent) for parent in Path(name).parents)
    parts = raw_name.split('/')
    cursor = []
    for index, part in enumerate(parts):
        if not part:
            continue
        if part == '.':
            continue
        if part == '..':
            if cursor:
                cursor.pop()
            continue
        cursor.append(part)
        final = index == len(parts) - 1
        if cursor[0] == 'work':
            source = root.joinpath(*cursor[1:])
            if final:
                return os.path.lexists(source)
            if source.is_symlink():
                raise ValueError('unresolved source symlink traversal')
            if not source.is_dir():
                return False
        elif '/' + '/'.join(cursor) in virtual_dirs:
            continue  # supervisor-created mount roots
        elif cursor[0] in ('usr', 'bin', 'lib', 'lib64', 'etc'):
            source = Path('/').joinpath(*cursor)
            # --ro-bind dereferences the host source at its destination root.
            # /bin and /lib can be host symlinks but are sandbox directories.
            # Descendant symlinks are not covered by that mount guarantee.
            if len(cursor) > 1 and source.is_symlink():
                raise ValueError('unresolved system symlink traversal')
            if not source.is_dir():
                return False
        else:
            if cursor[0] in ('tmp', 'out', 'proc', 'dev'):
                # Dynamic mounts cannot be reconstructed from the source.
                raise ValueError('unresolved sandbox path traversal')
            # The sandbox root/home/opt contain only explicit mounts and
            # runtime ancestors; a missing component cannot be crossed by '..'.
            return False
    return bool(cursor and cursor[0] == 'work' and root.joinpath(*cursor[1:]).is_dir())


def resolve_failed_process_alias(raw_name, cwd):
    """Resolve proven self cwd/root links; unknown dynamic aliases fail closed.

    Keep the suffix raw so missing ancestors and trailing slash semantics are
    still checked by available_project_attempt, not erased by normpath.
    """
    alias = r'/proc/(self|thread-self|[0-9]+)(/task/[0-9]+)?/(cwd|root|fd)(?=/|$)|/dev/fd(?=/|$)'
    value = '/' + raw_name.lstrip('/')
    for _ in range(8):
        match = re.match(alias, value)
        if not match:
            if re.match(alias, '/' + posixpath.normpath(value).lstrip('/')):
                raise ValueError('unresolved dynamic alias traversal')
            return value
        # /proc/<pid>/task/<tid>/... names another thread's view; it cannot be
        # proven to be this process's cwd/root, so it fails closed.
        if match[1] not in ('self', 'thread-self') or match[2] or match[3] == 'fd':
            raise ValueError('unresolved dynamic fd or process alias')
        base = cwd if match[3] == 'cwd' else '/'
        if base is None:
            raise ValueError('unknown cwd for process alias')
        value = base.rstrip('/') + value[match.end():]
        if not value:
            value = '/'
    raise ValueError('recursive process alias traversal')


def resolve_recorded_symlinks(raw_name, symlinks):
    """Rewrite a path through symlinks the sandbox created itself.

    /tmp and /out start empty, so every symlink there was made by a traced
    symlink/symlinkat call. Without this, `ln -s /work /tmp/w; cat
    /tmp/w/hidden.txt` would probe an undeclared input unseen.
    """
    value = '/' + posixpath.normpath(raw_name).lstrip('/')
    rewritten = False
    for _ in range(16):
        for link in sorted(symlinks, key=len, reverse=True):
            if value == link or value.startswith(link + '/'):
                value = '/' + posixpath.normpath(symlinks[link] + value[len(link):]).lstrip('/')
                rewritten = True
                break
        else:
            # Untouched paths keep their raw form, so missing-ancestor and
            # trailing-slash semantics are still checked by the walk.
            return value if rewritten else raw_name
    raise ValueError('recursive symlink traversal')


# Calls that may legitimately never complete when their process is killed
# (its own exit, or waiting on children during PID-namespace teardown).
NON_FILE_TERMINAL_CALLS = ('exit', 'exit_group', 'wait4', 'waitid')


def trace_verdict(trace, declared, root, runtime_files):
    if not trace.exists() or trace.stat().st_size == 0:
        return False, ['missing read trace']
    violations, pending, events = [], {}, []
    written, cwds, symlinks = set(), {}, {}
    # Keep syscall entry order: a child can execute before clone's resumed line.
    for line in trace.read_text(errors='surrogateescape').splitlines():
        pid = line.split(maxsplit=1)[0] if line.strip() else ''
        # A process killed while a call that touches no file was returning is
        # logged as "<... wait4 resumed> <unfinished ...>) = ?"; that closes
        # the pending call rather than starting an overlapping one.
        killed_resume = re.search(r'<\.\.\. (\w+) resumed> <unfinished \.\.\.>', line)
        if killed_resume and killed_resume.group(1) in NON_FILE_TERMINAL_CALLS and pid in pending:
            pending.pop(pid)
            continue
        if '<unfinished ...>' in line:
            if pid in pending:
                violations.append('overlapping file syscall')
            pending[pid] = (len(events), line.split('<unfinished ...>', 1)[0])
            events.append(None)
            continue
        # A process killed while blocked in a call that never returns (its own
        # exit, or waiting for a child when the PID namespace is torn down)
        # leaves that call unfinished. Those calls touch no file; an unfinished
        # file syscall still fails below.
        if re.match(r'^\S+\s+\+\+\+ (exited|killed)', line) and pid in pending:
            name = re.match(r'^\S+\s+(\w+)\(', pending[pid][1])
            if name and name.group(1) in NON_FILE_TERMINAL_CALLS:
                pending.pop(pid)
        resumed = re.search(r'<\.\.\. \w+ resumed>', line)
        if resumed:
            prior = pending.pop(pid, None)
            if prior is None:
                violations.append('unmatched file syscall')
                continue
            index, prefix = prior
            events[index] = (pid, prefix + line[resumed.end():])
        else:
            events.append((pid, line))
    if pending:
        violations.append('unfinished file syscall')
    for event in events:
        if event is None:
            continue
        pid, line = event
        call = re.search(r'\b(\w+)\((.*)\)\s+=\s+(-?\d+)', line)
        if not call:
            continue
        syscall, args, result = call[1], call[2], int(call[3])
        if not cwds:
            cwds[pid] = [str(root)]
        state = cwds.setdefault(pid, [None])
        if syscall in ('symlink', 'symlinkat', 'rename', 'renameat', 'renameat2') and result == 0:
            # Record symlinks the sandbox creates (and moves) so failed probes
            # through them are audited at their real target.
            try:
                strings = [decode_trace_string(item) for item in re.findall(r'"((?:[^"\\]|\\.)*)"', args)]
                directories = [decode_trace_string(item) for item in re.findall(r'(?:AT_FDCWD|\d+)<([^<>]+)>', args)]
                def absolute(path, base):
                    return '/' + posixpath.normpath(path if path.startswith('/') else posixpath.join(base or state[0] or '/', path)).lstrip('/')
                if syscall.startswith('symlink'):
                    link = absolute(strings[-1], directories[-1] if directories else None)
                    if link == '/newroot' or link.startswith('/newroot/'):
                        continue  # bwrap building the sandbox, before /work exists
                    target = strings[0] if strings[0].startswith('/') else posixpath.join(posixpath.dirname(link), strings[0])
                    symlinks[link] = '/' + posixpath.normpath(target).lstrip('/')
                else:
                    old = absolute(strings[0], directories[0] if directories else None)
                    new = absolute(strings[1], directories[-1] if directories else None)
                    for link in [key for key in symlinks if key == old or key.startswith(old + '/')]:
                        symlinks[new + link[len(old):]] = symlinks.pop(link)
            except (ValueError, UnicodeError, IndexError):
                violations.append('unresolved symlink bookkeeping')
            continue
        if syscall in ('clone', 'clone3', 'fork', 'vfork') and result > 0:
            host_pid = re.search(r"=\s+\d+ /\* (\d+) in strace's PID NS \*/", line)
            child_pid = host_pid[1] if host_pid else str(result)
            cwds[child_pid] = state if 'CLONE_FS' in args else state.copy()
            continue
        attempted = re.search(r'"((?:[^"\\]|\\.)*)"(\.\.\.)?', args)
        name = None
        raw_name = None
        if attempted:
            try:
                if attempted[2]:
                    raise ValueError('truncated path')
                name = decode_trace_string(attempted[1])
                if not name.startswith('/'):
                    # *at calls supply a directory fd; ordinary access/execve/
                    # stat/open use the process cwd inherited at fork/clone.
                    directory = re.match(r'(?:AT_FDCWD|\d+)<([^<>]+)>\s*,', args)
                    if not directory and re.match(r'-?\d+(?:<[^>]*>)?\s*,', args):
                        raise ValueError('unresolved directory fd')
                    base = decode_trace_string(directory[1]) if directory else state[0]
                    if base is None:
                        raise ValueError('unknown cwd')
                    name = posixpath.join(base, name)
                raw_name = name
                name = '/' + posixpath.normpath(name).lstrip('/')
            except (ValueError, UnicodeError):
                if result < 0 or syscall == 'chdir':
                    violations.append('undecodable or unresolved file path')
                name = None
        if syscall == 'chdir' and result == 0:
            state[0] = name
        if syscall == 'fchdir' and result == 0:
            directory = re.match(r'\d+<([^<>]+)>$', args)
            try:
                state[0] = decode_trace_string(directory[1]) if directory else None
            except ValueError:
                state[0] = None
            if state[0] is None:
                violations.append('unresolved fchdir')
        if result < 0:
            if raw_name:
                try:
                    raw_name = resolve_failed_process_alias(raw_name, state[0])
                    if symlinks:
                        raw_name = resolve_recorded_symlinks(raw_name, symlinks)
                    name = '/' + posixpath.normpath(raw_name).lstrip('/')
                except ValueError as exc:
                    violations.append(str(exc))
                    continue
            if name and name.startswith('/work/'):
                relative = name[6:]
                try:
                    available = available_project_attempt(raw_name, root, runtime_files)
                    if relative not in declared and available:
                        violations.append('undeclared available project input: ' + relative)
                except ValueError as exc:
                    violations.append(str(exc))
            continue
        if syscall not in ('open', 'openat', 'openat2'):
            continue
        match = OPEN.search(line)
        if not match:
            violations.append('undecodable successful open')
            continue
        try:
            name = decode_trace_string(match[1])
        except ValueError:
            violations.append('undecodable successful open path')
            continue
        if name.startswith('/work/'):
            relative = name[6:]
            # Snapshot ancestor directories contain only declared descendants.
            if relative in declared or relative in written or any(
                    item.startswith(relative + '/') for item in declared):
                continue
            if any(flag in line for flag in ('O_WRONLY', 'O_RDWR', 'O_CREAT')):
                written.add(relative)
            else:
                violations.append('undeclared project read: ' + relative)
        elif name.startswith(('/home/', '/opt/', '/root/')) and name not in runtime_files:
            violations.append('undeclared home read: ' + name)
    return not violations, violations[:30]


class SupervisorTerminated(Exception):
    pass


def _terminated(signum, frame):
    raise SupervisorTerminated("supervisor terminated by signal %d" % signum)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--inputs-json", required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--runtime-files-json", default="[]")
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    # The budget covers the whole run, freezing included, so the caller's own
    # timeout (a little longer) never fires first. If it is killed anyway,
    # SIGTERM still tears down the traced sandbox, which runs in its own
    # session and would otherwise be orphaned.
    deadline = time.monotonic() + args.timeout
    signal.signal(signal.SIGTERM, _terminated)
    root = Path(args.root).resolve(strict=True)
    evidence = Path(args.evidence).resolve()
    if evidence.exists():
        raise ValueError("evidence directory already exists")
    evidence.mkdir(parents=True)
    record = {"version": 1, "status": "failed_or_unknown", "command": args.command,
              "exit_code": None, "read_trace_verified": False, "snapshot_unchanged": False,
              "source_unchanged": False, "process_group_gone": False}
    staging = None
    unprivileged = None
    try:
        if not root.is_dir() or evidence == root or root in evidence.parents:
            raise ValueError("evidence must be outside project root")
        names = json.loads(args.inputs_json)
        runtime_names = json.loads(args.runtime_files_json)
        if not isinstance(runtime_names, list) or any(not isinstance(name, str) or not name.startswith("/") for name in runtime_names):
            raise ValueError("runtime files must be absolute paths")
        runtime_files = {}
        for name in runtime_names:
            candidate = Path(name)
            if (not name.startswith(("/home/", "/opt/")) or ".." in candidate.parts or
                    candidate.resolve() != candidate or not candidate.is_file() or
                    root == candidate or root in candidate.parents or evidence == candidate or evidence in candidate.parents):
                raise ValueError("unsafe runtime file: " + name)
            runtime_files[name] = sha(candidate)
        record["runtime_files"] = runtime_files
        before = inventory(root, names)
        if not before:
            raise ValueError("empty frozen input")
        digest = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
        record["input_digest"] = digest
        tools = {}
        for name in ("bwrap", "strace"):
            binary = shutil.which(name)
            if not binary:
                raise FileNotFoundError(name + " required")
            tools[name] = {"path": str(Path(binary).resolve(strict=True)), "sha256": sha(Path(binary).resolve(strict=True))}
        record["host_tools"] = tools
        # A sandbox started by root keeps every capability in its user
        # namespace (it could remount the read-only system binds and write the
        # host /usr or /etc), and root-owned host files look like its own. Root
        # therefore runs the sandbox as an unprivileged identity, with the
        # snapshot, output and trace in a private staging directory that
        # identity can reach; they move into the evidence directory afterwards.
        if os.geteuid() == 0:
            try:
                nobody = pwd.getpwnam("nobody")
                unprivileged = (nobody.pw_uid, nobody.pw_gid)
            except KeyError:
                unprivileged = (65534, 65534)
            staging = Path(tempfile.mkdtemp(prefix="loop-isolated-"))
            os.chmod(staging, 0o711)
        workspace = staging or evidence
        snapshot = workspace / "snapshot"
        snapshot.mkdir()
        for name in before:
            dest = snapshot / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, dest, follow_symlinks=False)
            os.chmod(dest, before[name]["mode"])
        if inventory(snapshot, names) != before or inventory(root, names) != before:
            raise ValueError("inputs changed during freeze")
        if time.monotonic() >= deadline:
            raise TimeoutError("timeout expired while freezing inputs")
        record["snapshot_unchanged"] = True
        trace = workspace / "trace.log"
        output = workspace / "output"
        output.mkdir()
        if unprivileged:
            trace.touch(mode=0o600)
            for path in [snapshot, output, trace, *snapshot.rglob("*")]:
                os.chown(path, *unprivileged, follow_symlinks=False)
        # bwrap is never started as root here, so it runs unprivileged and
        # gives the sandboxed command no capabilities (the self-test checks
        # CapEff). --cap-drop is not passed: bubblewrap 0.8 applies it before
        # configuring the sandbox loopback, which then fails with EPERM.
        record["sandbox_identity"] = {"uid": unprivileged[0], "gid": unprivileged[1]} if unprivileged else {"uid": os.geteuid(), "gid": os.getegid()}
        sandbox = [tools["bwrap"]["path"], "--die-with-parent", "--unshare-user", "--unshare-net",
                   "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                   "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                   "--ro-bind", str(snapshot), "/work", "--bind", str(output), "/out",
                   "--dir", "/home", "--setenv", "HOME", "/tmp", "--chdir", "/work"]
        for system in ("/usr", "/bin", "/lib", "/lib64", "/etc"):
            if Path(system).exists():
                sandbox += ["--ro-bind", system, system]
        if any(name.startswith("/opt/") for name in runtime_files):
            sandbox += ["--dir", "/opt"]
        for name in runtime_files:
            for parent in reversed(Path(name).parents):
                if str(parent) not in ("/", "/home", "/opt", "/usr", "/bin", "/lib", "/lib64", "/etc"):
                    sandbox += ["--dir", str(parent)]
            sandbox += ["--ro-bind", name, name]
        sandbox += ["--", "/bin/sh", "-c", args.command]
        invocation = [tools["strace"]["path"], "-f", "-yy", "--decode-pids=pidns", "-e", "trace=%file,%process,fchdir", "-s", "65535", "-o", str(trace), *sandbox]
        with (evidence / "stdout.log").open("wb") as stdout, (evidence / "stderr.log").open("wb") as stderr:
            identity = {"user": unprivileged[0], "group": unprivileged[1], "extra_groups": []} if unprivileged else {}
            child = subprocess.Popen(invocation, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                     start_new_session=True, cwd=str(workspace) if unprivileged else root,
                                     env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"}, **identity)
            try:
                record["exit_code"] = child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except (subprocess.TimeoutExpired, SupervisorTerminated) as exc:
                record["timed_out"] = True
                if isinstance(exc, SupervisorTerminated):
                    record["error"] = str(exc)
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=0.5 if isinstance(exc, SupervisorTerminated) else 5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            for _ in range(20):
                if not living_process_group(child.pid):
                    record["process_group_gone"] = True
                    break
                time.sleep(0.05)
            if not record["process_group_gone"]:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    record["process_group_gone"] = True
        record["read_trace_verified"], record["read_violations"] = trace_verdict(trace, before, root, runtime_files)
        record["snapshot_unchanged"] = inventory(snapshot, names) == before
        record["source_unchanged"] = inventory(root, names) == before
        record["host_tools_unchanged"] = all(sha(Path(item["path"])) == item["sha256"] for item in tools.values())
        record["runtime_files_unchanged"] = all(sha(Path(name)) == digest for name, digest in runtime_files.items())
        record["status"] = "passed" if (record["exit_code"] == 0 and record["read_trace_verified"]
                  and record["snapshot_unchanged"] and record["source_unchanged"]
                  and record["host_tools_unchanged"] and record["runtime_files_unchanged"]
                  and record["process_group_gone"]) else "failed_or_unknown"
    except Exception as exc:
        record["error"] = str(exc)
    finally:
        if staging:
            # Bring the staged artifacts into the evidence directory and give
            # them back to root, so later processes of the sandbox identity
            # cannot alter what was judged.
            try:
                for name in ("snapshot", "output", "trace.log"):
                    if (staging / name).exists():
                        shutil.move(str(staging / name), str(evidence / name))
                        for path in [evidence / name, *(evidence / name).rglob("*")] if (evidence / name).is_dir() else [evidence / name]:
                            os.chown(path, 0, 0, follow_symlinks=False)
                shutil.rmtree(staging, ignore_errors=True)
            except Exception as exc:
                record["status"] = "failed_or_unknown"
                record["error"] = record.get("error") or "evidence staging cleanup failed: " + str(exc)
    (evidence / "terminal.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": record["status"], "evidence": str(evidence), "input_digest": record.get("input_digest")}))
    return 0 if record["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
