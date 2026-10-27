"""Parser and mode-identity regressions independent of sandbox availability."""
import importlib.util
from pathlib import Path
import tempfile
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('isolation', Path(__file__).with_name('isolated-verify.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'sub').mkdir()
    (root / 'hidden.txt').write_text('hidden')
    (root / 'sub/hidden.txt').write_text('hidden')
    trace = root / 'trace'
    for call in [
        'openat(AT_FDCWD</work>, "hidden.txt", O_RDONLY)',
        'openat(AT_FDCWD</work/sub>, "hidden.txt", O_RDONLY)',
        'openat(AT_FDCWD</work/sub>, "../hidden.txt", O_RDONLY)',
        'openat(3</work/sub>, "hidden.txt", O_RDONLY)',
        'statx(AT_FDCWD</work/sub>, "hidden.txt", 0, STATX_ALL, 0x123)',
        'openat(AT_FDCWD</work/sub>, "hidden.txt", O_RDONLY <unfinished ...>\n1 <... openat resumed>)',
    ]:
        trace.write_text('1 ' + call + ' = -1 ENOENT (No such file or directory)\n')
        ok, errors = module.trace_verdict(trace, {}, root, {})
        assert not ok and any('undeclared available project input' in e for e in errors), (call, errors)
    trace.write_text('1 openat(AT_FDCWD</work/sub>, "absent.txt", O_RDONLY) = -1 ENOENT (No such file or directory)\n')
    assert module.trace_verdict(trace, {}, root, {}) == (True, [])
    script = root / 'test.sh'
    script.write_text('#!/bin/sh\ntrue\n')
    script.chmod(0o755)
    before = module.inventory(root, ['test.sh'])
    script.chmod(0o644)
    after = module.inventory(root, ['test.sh'])
    assert before != after
    assert before['test.sh']['sha256'] == after['test.sh']['sha256']
    assert before['test.sh']['mode'] == 0o755
print('isolation parser and permission identity regressions passed')

# Byte escapes, malformed/truncated paths, process cwd inheritance and fchdir.
assert module.decode_trace_string(r'\344\270\255\346\226\207') == '中文'
assert module.decode_trace_string(r'a\"b\\c') == 'a"b\\c'
for value in [r'\q', r'\xZZ', r'\000', r'\777']:
    try:
        module.decode_trace_string(value)
        raise AssertionError(value)
    except ValueError:
        pass
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'sub').mkdir()
    (root / 'sub/hidden.txt').write_text('secret')
    trace = root / 'trace'
    for transition in ['1 chdir("/work/sub") = 0', '1 fchdir(3</work/sub>) = 0']:
        for filename, expected in [('hidden.txt', False), ('absent.txt', True)]:
            trace.write_text(transition + '\n1 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n'
                             + f'2 access("{filename}", R_OK) = -1 ENOENT (missing)\n'
                             + '1 <... clone resumed>) = 2\n')
            assert module.trace_verdict(trace, {}, root, {})[0] == expected
    for path in ['"hidden"...', r'"\q"']:
        trace.write_text(f'1 access({path}, R_OK) = -1 ENOENT (missing)\n')
        assert not module.trace_verdict(trace, {}, root, {})[0]
print('C byte escapes, truncated paths and inherited cwd regressions passed')

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'hidden.txt').write_text('secret')
    trace = root / 'trace'
    trace.write_text('1 chdir("/work") = 0\n'
                    "1 clone(child_stack=NULL, flags=SIGCHLD) = 2 /* 12345 in strace's PID NS */\n"
                    '12345 access("hidden.txt", R_OK) = -1 ENOENT (missing)\n')
    assert not module.trace_verdict(trace, {}, root, {})[0]
    trace.write_text('1 openat(4, "absent.txt", O_RDONLY) = -1 ENOENT (missing)\n')
    assert not module.trace_verdict(trace, {}, root, {})[0]
print('PID namespace mapping and unknown directory fd regressions passed')

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'sub').mkdir()
    (root / 'hidden.txt').write_text('private')
    (root / 'input.txt').write_text('declared')
    trace = root / 'trace'
    for name, allowed in [
        ('../work/hidden.txt', False), ('/work/../work/hidden.txt', False),
        ('//work/hidden.txt', False), ('///work//hidden.txt', False),
        ('/work/../../work/sub/../../work/hidden.txt', False),
        ('../work/missing.txt', True), ('//work/absent/../hidden.txt', True),
        ('../work/input.txt/../hidden.txt', True),
        ('/work/../work/hidden.txt/', True), ('/work/../work/hidden.txt/.', True),
        ('/nonexistent_r4/../work/hidden.txt', True),
        ('/work/../nonexistent_r4/../work/hidden.txt', True),
        ('/home/../work/hidden.txt', False),
    ]:
        trace.write_text(f'1 openat(AT_FDCWD</work>, "{name}", O_RDONLY) = -1 ENOENT (missing)\n')
        ok, errors = module.trace_verdict(trace, {'input.txt': {}}, root, {})
        assert ok == allowed, (name, errors)
print('namespace re-entry, slash aliases and missing component regressions passed')

# Explicit ro-bind roots differ from internal system symlinks.
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'hidden.txt').write_text('private')
    for mount in ['bin', 'lib', 'lib64', 'usr', 'etc']:
        if not Path('/' + mount).is_dir():
            continue
        assert not module.available_project_attempt('/' + mount + '/../work/missing.txt', root, {})
        assert module.available_project_attempt('/' + mount + '/../work/hidden.txt', root, {})
    # Use a mocked descendant type: no changes to the host system directories.
    from unittest.mock import patch
    original = Path.is_symlink
    with patch.object(Path, 'is_symlink', lambda p: str(p) == '/usr/internal-link' or original(p)):
        try:
            module.available_project_attempt('/usr/internal-link/../../work/hidden.txt', root, {})
            raise AssertionError('unknown internal symlink must fail closed')
        except ValueError as error:
            assert 'unresolved system symlink' in str(error)
print('ro-bind roots and unknown descendant symlinks passed')

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'hidden.txt').write_text('hidden')
    (root / 'sub').mkdir()
    trace = root / 'trace'
    for prefix in ['/proc/self/cwd/', '/proc/thread-self/cwd/', '/proc/self/root/work/']:
        for suffix, allowed in [('hidden.txt', False), ('missing.txt', True), ('absent/../hidden.txt', True), ('hidden.txt/', True)]:
            trace.write_text('1 chdir("/work") = 0\n' + f'1 access("{prefix}{suffix}", R_OK) = -1 ENOENT (missing)\n')
            ok, errors = module.trace_verdict(trace, {}, root, {})
            assert ok == allowed, (prefix, suffix, errors)
    for name in ['/dev/fd/9/hidden.txt', '/proc/self/fd/9/hidden.txt', '/proc/9/cwd/hidden.txt']:
        trace.write_text(f'1 access("{name}", R_OK) = -1 ENOENT (missing)\n')
        assert not module.trace_verdict(trace, {}, root, {})[0]
print('self cwd/root aliases and unknown fd/process alias regressions passed')
