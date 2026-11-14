#!/usr/bin/env python3
"""Fetch the pinned robot-model corpus that ROCO's importers are tested against (stdlib only, plus git).

    python3 -I tools/corpus/fetch.py [--only NAME ...] [--cache DIR] [--lock FILE] [--max-mb 300]
    python3 -I tools/corpus/fetch.py --self-test

Each model in corpus.lock.json names a git repo, a full commit, the folder to check out ('package') and the model file
('path'). Models that share a repo and commit share one checkout, <cache>/<repo>-<commit[:12]>, made with a shallow
partial fetch of exactly that commit and a sparse checkout of the packages. The cache defaults to ~/.cache/roco-corpus
and may not be inside this repo: corpus files never enter it.

Checks, any of which stops the run with exit 1:
  - every lock entry is well formed: known group, format and licence (permissive only), a 40-hex commit, an https repo,
    relative paths with no '..', and the model file inside its package;
  - HEAD of each checkout equals the pinned commit;
  - every checked-out path, and the target of every symlink, stays inside the checkout;
  - each model file exists and is a regular file;
  - the total size stays under --max-mb (checked after each repo).

Nothing from a checkout is ever run. git runs with hooks off, the user's global git config ignored, no prompts, and
https as the only protocol.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
LOCK = HERE / 'corpus.lock.json'
DEFAULT_CACHE = Path.home() / '.cache' / 'roco-corpus'
GROUPS = {'arms', 'humanoids', 'quadrupeds', 'wheeled', 'hands', 'drones'}
FORMATS = {'urdf', 'xacro', 'mjcf', 'sdf', 'usd'}
LICENCES = {'MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'CC0-1.0', 'Zlib', 'Unlicense'}
REQUIRED = ('name', 'group', 'repo', 'commit', 'package', 'path', 'format', 'licence', 'source')


class FetchError(Exception):
    pass


def safe_rel(p, allow_dot=False):
    """Whether p is a plain relative path: no absolute start, no backslash, no '..', no empty or odd parts."""
    if not isinstance(p, str) or not p or '\\' in p or '\0' in p or p.startswith('/'):
        return False
    if p == '.':
        return allow_dot
    return all(part not in ('', '.', '..') for part in p.split('/'))


def entry_problems(e, allow_file=False):
    """What is wrong with one lock entry (empty list when it is fine)."""
    if not isinstance(e, dict):
        return ['entry is not an object']
    missing = [k for k in REQUIRED if not isinstance(e.get(k), str) or not e.get(k)]
    if missing:
        return ['missing or empty: ' + ', '.join(missing)]
    out = []
    if not re.fullmatch(r'[a-z0-9_]+', e['name']):
        out.append('name must be lower-case letters, digits and _')
    if e['group'] not in GROUPS:
        out.append(f"unknown group {e['group']!r}")
    if e['format'] not in FORMATS:
        out.append(f"unknown format {e['format']!r}")
    if e['licence'] not in LICENCES:
        out.append(f"licence {e['licence']!r} is not on the permissive list")
    if not re.fullmatch(r'[0-9a-f]{40}', e['commit']):
        out.append('commit must be a full 40-character hex SHA')
    schemes = ('https://', 'file://') if allow_file else ('https://',)
    if not e['repo'].startswith(schemes) or re.search(r'\s', e['repo']):
        out.append('repo must be an https:// URL')
    if not safe_rel(e['package'], allow_dot=True):
        out.append('package must be a relative path with no ".."')
    if not safe_rel(e['path']):
        out.append('path must be a relative path with no ".."')
    elif safe_rel(e['package'], allow_dot=True) and e['package'] != '.' and not e['path'].startswith(e['package'] + '/'):
        out.append('path must be inside package')
    args = e.get('xacro_args', {})
    if not isinstance(args, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                             and re.fullmatch(r'[A-Za-z0-9_.-]+', k + v) for k, v in args.items()):
        out.append('xacro_args must map plain names to plain values')
    return out


def load_lock(path, allow_file=False):
    """The models in a lock file. Raises FetchError naming every problem."""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise FetchError(f'cannot read {path}: {exc}')
    models = data.get('models') if isinstance(data, dict) else None
    if not isinstance(models, list) or not models:
        raise FetchError(f'{path}: no "models" list')
    problems, seen = [], set()
    for i, e in enumerate(models):
        label = e.get('name') if isinstance(e, dict) and isinstance(e.get('name'), str) else f'#{i}'
        problems += [f'{label}: {p}' for p in entry_problems(e, allow_file)]
        if label in seen:
            problems.append(f'{label}: duplicate name')
        seen.add(label)
    if problems:
        raise FetchError('bad lock entries:\n  ' + '\n  '.join(problems))
    return models


def checkout_name(repo, commit):
    base = re.sub(r'\.git$', '', repo.rstrip('/').rsplit('/', 1)[-1])
    return re.sub(r'[^A-Za-z0-9_.-]', '_', base) + '-' + commit[:12]


def git(args, cwd, protocols):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
               GIT_ALLOW_PROTOCOL=protocols)
    r = subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull, '-c', 'advice.detachedHead=false', *args],
                       cwd=cwd, env=env, capture_output=True, text=True)
    if r.returncode:
        raise FetchError(f"git {args[0]} failed: {(r.stderr or r.stdout).strip().splitlines()[-1:] or ['?']}")
    return r.stdout.strip()


def inside(root, p):
    root, p = os.path.realpath(root), os.path.realpath(p)
    return p == root or p.startswith(root + os.sep)


def tree_problems(dest, packages):
    """Paths or symlink targets that leave the checkout, and packages that are missing."""
    out = []
    for pkg in packages:
        top = os.path.join(dest, pkg)
        if not inside(dest, top):
            out.append(f'package {pkg} leaves the checkout')
            continue
        if not os.path.isdir(top):
            out.append(f'package {pkg} is not in the checkout')
            continue
        for d, dirs, files in os.walk(top):
            if '.git' in dirs and os.path.realpath(d) == os.path.realpath(dest):
                dirs.remove('.git')
            for name in dirs + files:
                p = os.path.join(d, name)
                if os.path.islink(p) and not inside(dest, p):
                    out.append(f'symlink {os.path.relpath(p, dest)} points outside the checkout')
    return out


def size_bytes(top):
    total = 0
    for d, _dirs, files in os.walk(top):
        for name in files:
            total += os.lstat(os.path.join(d, name)).st_size
    return total


def fetch_checkout(repo, commit, packages, dest, protocols='https'):
    """Make dest a checkout of exactly `commit` with only `packages`. Returns 'fetched' or 'cached'."""
    dest = Path(dest)
    state = 'cached'
    if not dest.exists():
        state = 'fetched'
        tmp = dest.with_name(dest.name + '.partial')
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)
        git(['init', '-q'], tmp, protocols)
        git(['remote', 'add', 'origin', repo], tmp, protocols)
        if '.' not in packages:
            git(['sparse-checkout', 'init', '--cone'], tmp, protocols)
            git(['sparse-checkout', 'set', *sorted(packages)], tmp, protocols)
        try:
            git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit], tmp, protocols)
        except FetchError as exc:
            shutil.rmtree(tmp)
            raise FetchError(f'commit {commit} could not be fetched from {repo} ({exc})')
        git(['checkout', '-q', '--detach', commit], tmp, protocols)
        tmp.rename(dest)
    head = git(['rev-parse', 'HEAD'], dest, protocols)
    if head != commit:
        raise FetchError(f'{dest} is at {head}, not the pinned {commit}; delete it and fetch again')
    problems = tree_problems(dest, packages)
    if problems:
        raise FetchError(f'{dest}: ' + '; '.join(problems))
    return state


def run(models, cache, max_mb, protocols='https', log=print):
    """Fetch every model. Returns {name: model file path}. Raises FetchError on the first failure."""
    cache = Path(cache)
    if inside(REPO_ROOT, cache):
        raise FetchError('the cache must be outside the repo (corpus files never enter it)')
    groups = {}
    for m in models:
        groups.setdefault((m['repo'], m['commit']), []).append(m)
    total, files = 0, {}
    for (repo, commit), ms in groups.items():
        packages = {'.'} if any(m['package'] == '.' for m in ms) else {m['package'] for m in ms}
        dest = cache / checkout_name(repo, commit)
        state = fetch_checkout(repo, commit, packages, dest, protocols)
        size = size_bytes(dest)
        total += size
        log(f'[fetch] {state} {dest.name} ({size / 1e6:.1f} MB): {", ".join(m["name"] for m in ms)}')
        for m in ms:
            f = dest / m['path']
            if not inside(dest, f) or f.is_symlink() or not f.is_file():
                raise FetchError(f"{m['name']}: {m['path']} is not a regular file in the checkout")
            files[m['name']] = f
        if total > max_mb * 1e6:
            raise FetchError(f'the corpus is {total / 1e6:.1f} MB, over the {max_mb} MB cap; stopping')
    log(f'[fetch] {len(files)} models, {total / 1e6:.1f} MB in {cache}')
    return files


def self_test():
    results = []

    def check(ok, what):
        results.append((bool(ok), what))

    def fails(fn, *words):
        try:
            fn()
        except FetchError as exc:
            return all(w in str(exc) for w in words)
        return False

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / 'src'
        (src / 'pkg' / 'meshes').mkdir(parents=True)
        (src / 'other').mkdir()
        (src / 'pkg' / 'model.urdf').write_text('<robot name="t"/>\n')
        (src / 'pkg' / 'meshes' / 'a.stl').write_text('solid a\nendsolid a\n')
        (src / 'other' / 'big.bin').write_text('x' * 1000)

        def g(*args):
            return git(['-c', 'user.name=t', '-c', 'user.email=t@t', *args], src, 'file')
        g('init', '-q')
        g('config', 'uploadpack.allowFilter', 'true')
        g('config', 'uploadpack.allowAnySHA1InWant', 'true')
        g('add', '.')
        g('commit', '-q', '-m', 'one')
        good = g('rev-parse', 'HEAD')
        os.symlink('../../../outside', src / 'pkg' / 'evil')
        g('add', '.')
        g('commit', '-q', '-m', 'two')
        evil = g('rev-parse', 'HEAD')

        url = 'file://' + str(src)
        base = {'name': 'm', 'group': 'arms', 'repo': url, 'commit': good, 'package': 'pkg', 'path': 'pkg/model.urdf',
                'format': 'urdf', 'licence': 'MIT', 'source': 'self-test'}
        quiet = lambda *_: None  # noqa: E731
        cache = tmp / 'cache'

        files = run([base], cache, 1, 'file', quiet)
        dest = cache / checkout_name(url, good)
        check(files.get('m', Path()).is_file(), 'a good entry is fetched')
        check(not (dest / 'other').exists(), 'only the package is checked out (sparse)')
        check(git(['rev-parse', 'HEAD'], dest, 'file') == good, 'HEAD is the pinned commit')
        log = []
        run([base], cache, 1, 'file', log.append)
        check(any(line.startswith('[fetch] cached') for line in log), 'a second run reuses the checkout')
        whole = dict(base, package='.', name='w')
        check('w' in run([whole], tmp / 'cache2', 1, 'file', quiet), "package '.' checks out the whole repo")

        wrong = 'f' * 40
        check(fails(lambda: run([dict(base, commit=wrong)], tmp / 'c3', 1, 'file', quiet), wrong),
              'an unknown commit fails, naming it')
        check(fails(lambda: run([dict(base, commit=evil)], tmp / 'c4', 1, 'file', quiet), 'symlink'),
              'a symlink pointing out of the checkout fails')
        (dest / 'pkg' / 'model.urdf').unlink()
        check(fails(lambda: run([base], cache, 1, 'file', quiet), 'not a regular file'), 'a missing model file fails')
        check(fails(lambda: run([base], REPO_ROOT / 'build' / 'corpus', 1, 'file', quiet), 'outside the repo'),
              'a cache inside the repo is refused')
        big = dict(base, name='b', package='.')
        check(fails(lambda: run([big], tmp / 'c5', 0.000001, 'file', quiet), 'cap'), 'going over the size cap stops')

        bad = {
            'path with ..': dict(base, path='pkg/../../x.urdf'),
            'absolute path': dict(base, path='/etc/x.urdf'),
            'package with ..': dict(base, package='..'),
            'path outside package': dict(base, path='other/big.bin'),
            'missing key': {k: v for k, v in base.items() if k != 'commit'},
            'short commit': dict(base, commit=good[:12]),
            'unknown group': dict(base, group='boats'),
            'unknown format': dict(base, format='obj'),
            'copyleft licence': dict(base, licence='GPL-3.0'),
            'plain http repo': dict(base, repo='http://example.com/r.git'),
            'odd xacro arg': dict(base, xacro_args={'a': '$(evil)'}),
        }
        for what, e in bad.items():
            lock = tmp / 'lock.json'
            lock.write_text(json.dumps({'models': [e]}))
            check(fails(lambda: load_lock(lock, allow_file=True), 'bad lock entries'), f'a lock entry with {what} fails')
        lock.write_text(json.dumps({'models': [base, base]}))
        check(fails(lambda: load_lock(lock, allow_file=True), 'duplicate'), 'a duplicate name fails')
        lock.write_text(json.dumps({'models': [base]}))
        check(fails(lambda: load_lock(lock), 'https'), 'file:// repos are refused outside the self-test')
        lock.write_text('{not json')
        check(fails(lambda: load_lock(lock), 'cannot read'), 'a malformed lock file fails')
        check(len(load_lock(LOCK)) >= 12, "the repo's corpus.lock.json is well formed")

    failed = [what for ok, what in results if not ok]
    for what in failed:
        print('FAIL: ' + what, file=sys.stderr)
    print(f'fetch: {len(results) - len(failed)} checks passed' + (f', {len(failed)} FAILED' if failed else ''))
    return 1 if failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='Fetch the pinned robot-model corpus.')
    ap.add_argument('--lock', default=str(LOCK))
    ap.add_argument('--cache', default=str(DEFAULT_CACHE))
    ap.add_argument('--only', action='append', metavar='NAME', help='fetch only this model (repeatable)')
    ap.add_argument('--max-mb', type=float, default=300)
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    try:
        models = load_lock(a.lock)
        if a.only:
            unknown = set(a.only) - {m['name'] for m in models}
            if unknown:
                raise FetchError('not in the lock: ' + ', '.join(sorted(unknown)))
            models = [m for m in models if m['name'] in a.only]
        run(models, a.cache, a.max_mb)
    except FetchError as exc:
        print(f'[fetch] FAIL: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
