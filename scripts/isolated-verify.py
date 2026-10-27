#!/usr/bin/env python3
"""Fail-closed Linux verification of explicitly frozen project inputs.

The project supplies file/directory inputs and a command. This supervisor is
host-owned; strace wraps bwrap, so the sandbox cannot edit its read trace.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess


OPEN = re.compile(r"=\s+\d+<([^<>]+)(?:<[^>]+>)?>(?:\(deleted\))?\s*$")


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


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
                files[relative] = {"sha256": sha(candidate), "size": candidate.stat().st_size}
            elif not candidate.is_dir():
                raise ValueError("special input: " + relative)
    return dict(sorted(files.items()))


def trace_verdict(trace, declared, root, runtime_files):
    if not trace.exists() or trace.stat().st_size == 0:
        return False, ["missing read trace"]
    violations = []
    pending = {}
    written = set()
    for line in trace.read_text(errors="replace").splitlines():
        pid = line.split(maxsplit=1)[0] if line.strip() else ""
        if " = -1 " in line:
            attempted = re.search(r'"([^"\\]+)"', line)
            if attempted:
                name = attempted.group(1)
                if name.startswith("/work/"):
                    relative = name[6:]
                elif 'AT_FDCWD</work>' in line and not name.startswith("/"):
                    relative = name
                else:
                    relative = None
                if relative and relative not in declared and (root / relative).exists():
                    violations.append("undeclared available project input: " + relative)
            continue
        if "<unfinished ...>" in line and re.search(r"\bopen(?:at2?)?\(", line):
            if pid in pending:
                violations.append("overlapping open")
            pending[pid] = line.split("<unfinished ...>", 1)[0]
            continue
        resumed = re.search(r"<\.\.\. (?:open|openat|openat2) resumed>", line)
        if resumed:
            prior = pending.pop(pid, None)
            if prior is None:
                violations.append("unmatched open")
                continue
            line = prior + line[resumed.end():]
        if not re.search(r"\bopen(?:at2?)?\(", line):
            continue
        match = OPEN.search(line)
        if not match:
            violations.append("undecodable successful open")
            continue
        name = match.group(1)
        if name.startswith("/work/"):
            relative = name[6:]
            if relative in declared or relative in written:
                continue
            if any(flag in line for flag in ("O_WRONLY", "O_RDWR", "O_CREAT")):
                written.add(relative)
            else:
                violations.append("undeclared project read: " + relative)
        elif (name.startswith("/home/") or name.startswith("/root/")) and name not in runtime_files:
            violations.append("undeclared home read: " + name)
    if pending:
        violations.append("unfinished open")
    return not violations, violations[:30]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--inputs-json", required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--runtime-files-json", default="[]")
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    root = Path(args.root).resolve(strict=True)
    evidence = Path(args.evidence).resolve()
    if evidence.exists():
        raise ValueError("evidence directory already exists")
    evidence.mkdir(parents=True)
    record = {"version": 1, "status": "failed_or_unknown", "command": args.command,
              "exit_code": None, "read_trace_verified": False, "snapshot_unchanged": False,
              "source_unchanged": False, "process_group_gone": False}
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
            if (not name.startswith("/home/") or ".." in candidate.parts or
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
        snapshot = evidence / "snapshot"
        snapshot.mkdir()
        for name in before:
            dest = snapshot / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, dest, follow_symlinks=False)
        if inventory(snapshot, names) != before or inventory(root, names) != before:
            raise ValueError("inputs changed during freeze")
        record["snapshot_unchanged"] = True
        trace = evidence / "trace.log"
        output = evidence / "output"
        output.mkdir()
        sandbox = [tools["bwrap"]["path"], "--die-with-parent", "--unshare-net",
                   "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                   "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                   "--ro-bind", str(snapshot), "/work", "--bind", str(output), "/out",
                   "--dir", "/home", "--setenv", "HOME", "/tmp", "--chdir", "/work"]
        for system in ("/usr", "/bin", "/lib", "/lib64", "/etc"):
            if Path(system).exists():
                sandbox += ["--ro-bind", system, system]
        for name in runtime_files:
            for parent in reversed(Path(name).parents):
                if str(parent) not in ("/", "/home", "/usr", "/bin", "/lib", "/lib64", "/etc"):
                    sandbox += ["--dir", str(parent)]
            sandbox += ["--ro-bind", name, name]
        sandbox += ["--", "/bin/sh", "-c", args.command]
        invocation = [tools["strace"]["path"], "-f", "-yy", "-e", "trace=%file", "-o", str(trace), *sandbox]
        with (evidence / "stdout.log").open("wb") as stdout, (evidence / "stderr.log").open("wb") as stderr:
            child = subprocess.Popen(invocation, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                     start_new_session=True, env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"})
            try:
                record["exit_code"] = child.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                record["timed_out"] = True
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                record["process_group_gone"] = True
            else:
                os.killpg(child.pid, signal.SIGKILL)
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
    (evidence / "terminal.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": record["status"], "evidence": str(evidence), "input_digest": record.get("input_digest")}))
    return 0 if record["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
