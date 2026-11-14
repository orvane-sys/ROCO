#!/usr/bin/env python3
"""Record what reference tools read from each corpus model, so ROCO's importers can be checked against them.

    python3 -I tools/corpus/reference.py [--only NAME ...] [--cache DIR] [--lock FILE]
    python3 -I tools/corpus/reference.py --self-test

Run it with an interpreter that has mujoco and xacro installed (pip), after tools/corpus/fetch.py. It writes one JSON
per model to <cache>/reference/<name>.json:
  - mjcf:  mujoco compiles the model; bodies, joints (type, axis, range), meshes, geoms and actuators;
  - urdf:  ElementTree; links, joints (type, parent, child, axis, limits) and mesh references, and how many of them
           resolve to a file (package:// names come from the checkout's package.xml files);
  - xacro: xacro expands the file with the lock's xacro_args, $(find pkg) resolved from the same package.xml map,
           then it is read as urdf;
  - sdf:   `gz sdf -p`, when gz is installed.
A model that cannot be read is recorded as {"ok": false, "reason": ...}; that is data, not a crash. The run exits 0
once every model is recorded, and 1 only on a usage error.
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('roco_corpus_fetch', HERE / 'fetch.py')
fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch)


def package_map(root):
    """{package name: folder} for every package.xml under root."""
    out = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x != '.git']
        if 'package.xml' in files:
            try:
                name = ET.parse(os.path.join(d, 'package.xml')).getroot().findtext('name')
            except ET.ParseError:
                continue
            if name and name.strip():
                out.setdefault(name.strip(), d)
    return out


def resolve_mesh(ref, model_file, packages):
    """The file a URDF mesh filename points at, or None when it cannot be resolved."""
    if ref.startswith('package://'):
        name, _, rest = ref[len('package://'):].partition('/')
        base = packages.get(name)
        return os.path.join(base, rest) if base else None
    if ref.startswith('file://'):
        return None                     # absolute paths on the author's machine never resolve here
    return os.path.join(os.path.dirname(model_file), ref)


def floats(text):
    try:
        return [round(float(x), 6) for x in text.split()]
    except (AttributeError, ValueError):
        return None


def read_urdf(xml_text, model_file, packages):
    root = ET.fromstring(xml_text)
    if root.tag != 'robot':
        raise ValueError(f'root element is <{root.tag}>, not <robot>')
    joints = []
    for j in root.findall('joint'):
        limit = j.find('limit')
        lim = None
        if limit is not None and limit.get('lower') is not None and limit.get('upper') is not None:
            lim = [round(float(limit.get('lower')), 6), round(float(limit.get('upper')), 6)]
        axis = j.find('axis')
        joints.append({'name': j.get('name'), 'type': j.get('type'),
                       'parent': (j.find('parent') if j.find('parent') is not None else ET.Element('x')).get('link'),
                       'child': (j.find('child') if j.find('child') is not None else ET.Element('x')).get('link'),
                       'axis': floats(axis.get('xyz')) if axis is not None else [1.0, 0.0, 0.0], 'limit': lim})
    refs = sorted({m.get('filename') for m in root.iter('mesh') if m.get('filename')})
    found = [r for r in refs if (p := resolve_mesh(r, model_file, packages)) and os.path.isfile(p)]
    return {'robot': root.get('name'), 'links': len(root.findall('link')), 'joints': joints,
            'movable_joints': sum(j['type'] not in ('fixed', None) for j in joints),
            'mesh_refs': len(refs), 'mesh_refs_resolved': len(found),
            'mesh_refs_missing': [r for r in refs if r not in found][:20]}


def expand_xacro(model_file, args, packages):
    import xacro
    import xacro.substitution_args as sa

    def find(pkg):
        if pkg not in packages:
            raise KeyError(f'package {pkg!r} has no package.xml in the checkout')
        return packages[pkg]
    old = sa._eval_find, sa._eval_dict.get('find')
    sa._eval_find = sa._eval_dict['find'] = find
    try:
        doc = xacro.process_file(str(model_file), mappings=dict(args))
    finally:
        sa._eval_find, sa._eval_dict['find'] = old
    from importlib.metadata import PackageNotFoundError, version
    try:
        v = version('xacro')
    except PackageNotFoundError:
        v = 'unknown version'
    return doc.toxml(), 'xacro ' + v


def read_mjcf(model_file):
    import mujoco
    m = mujoco.MjModel.from_xml_path(str(model_file))
    joints = []
    for i in range(m.njnt):
        joints.append({'name': mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, i),
                       'type': mujoco.mjtJoint(m.jnt_type[i]).name.replace('mjJNT_', '').lower(),
                       'axis': [round(float(x), 6) for x in m.jnt_axis[i]],
                       'range': [round(float(x), 6) for x in m.jnt_range[i]] if m.jnt_limited[i] else None})
    return {'tool': 'mujoco ' + mujoco.__version__, 'bodies': int(m.nbody), 'joints': joints,
            'movable_joints': sum(j['type'] != 'free' for j in joints), 'meshes': int(m.nmesh),
            'geoms': int(m.ngeom), 'actuators': int(m.nu)}


def reference(model, model_file, checkout):
    """The reference record for one model. Never raises."""
    t0 = time.perf_counter()
    rec = {'name': model['name'], 'group': model['group'], 'format': model['format'], 'commit': model['commit'],
           'path': model['path']}
    try:
        if not Path(model_file).is_file():
            raise FileNotFoundError('model file is missing; run tools/corpus/fetch.py first')
        fmt = model['format']
        if fmt == 'mjcf':
            rec.update(read_mjcf(model_file))
        elif fmt in ('urdf', 'xacro'):
            packages = package_map(checkout)
            if fmt == 'xacro':
                text, tool = expand_xacro(model_file, model.get('xacro_args', {}), packages)
            else:
                text, tool = Path(model_file).read_text(encoding='utf-8'), 'xml.etree'
            rec['tool'] = tool
            rec.update(read_urdf(text, model_file, packages))
        elif fmt == 'sdf':
            gz = shutil.which('gz')
            if not gz:
                raise RuntimeError('gz is not installed, so there is no SDF reference')
            r = subprocess.run([gz, 'sdf', '-p', str(model_file)], capture_output=True, text=True, timeout=120)
            if r.returncode:
                raise RuntimeError('gz sdf -p failed: ' + (r.stderr.strip().splitlines() or ['?'])[-1])
            rec['tool'] = 'gz sdf'
            rec['sdf_bytes'] = len(r.stdout)
        else:
            raise RuntimeError(f'no reference tool for {fmt} yet')
        rec['ok'] = True
    except Exception as exc:   # a model that cannot be read is a result, not a crash
        rec['ok'] = False
        rec['reason'] = f'{type(exc).__name__}: {exc}'[:400]
    rec['seconds'] = round(time.perf_counter() - t0, 3)
    return rec


def summary(rec):
    if not rec['ok']:
        return f"{rec['name']:18} {rec['format']:5} FAIL  {rec['reason']}"
    if rec['format'] == 'mjcf':
        size = f"bodies {rec['bodies']:3}  joints {len(rec['joints']):3} ({rec['movable_joints']} movable)  meshes {rec['meshes']}"
    else:
        size = (f"links  {rec['links']:3}  joints {len(rec['joints']):3} ({rec['movable_joints']} movable)  "
                f"mesh refs {rec['mesh_refs_resolved']}/{rec['mesh_refs']} resolve")
    return f"{rec['name']:18} {rec['format']:5} ok    {size}  [{rec['tool']}, {rec['seconds']} s]"


def self_test():
    results = []

    def check(ok, what):
        results.append((bool(ok), what))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / 'meshes').mkdir()
        (tmp / 'meshes' / 'a.stl').write_text('solid a\nendsolid a\n')
        (tmp / 'package.xml').write_text('<package><name>tpkg</name></package>\n')
        urdf = ('<robot name="t"><link name="a"/><link name="b"><visual><geometry>'
                '<mesh filename="package://tpkg/meshes/a.stl"/></geometry></visual></link>'
                '<link name="c"><visual><geometry><mesh filename="meshes/missing.stl"/></geometry></visual></link>'
                '<joint name="j1" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 0 1"/>'
                '<limit lower="-1" upper="1"/></joint><joint name="j2" type="fixed"><parent link="b"/>'
                '<child link="c"/></joint></robot>')
        (tmp / 't.urdf').write_text(urdf)
        (tmp / 'bad.urdf').write_text('<robot name="t"><link>')
        (tmp / 'sdf.urdf').write_text('<sdf version="1.9"/>')
        base = {'name': 't', 'group': 'arms', 'format': 'urdf', 'commit': '0' * 40, 'path': 't.urdf'}

        r = reference(base, tmp / 't.urdf', tmp)
        check(r['ok'] and r['links'] == 3 and len(r['joints']) == 2 and r['movable_joints'] == 1, 'a URDF is read')
        check(r['ok'] and r['joints'][0]['axis'] == [0.0, 0.0, 1.0] and r['joints'][0]['limit'] == [-1.0, 1.0],
              'joint axis and limits are read')
        check(r['ok'] and r['mesh_refs'] == 2 and r['mesh_refs_resolved'] == 1
              and r['mesh_refs_missing'] == ['meshes/missing.stl'], 'package:// resolves and a missing mesh is listed')
        check(not reference(base, tmp / 'bad.urdf', tmp)['ok'], 'a malformed URDF is recorded as not ok')
        check('not <robot>' in reference(base, tmp / 'sdf.urdf', tmp).get('reason', ''), 'a non-robot root is refused')
        check('missing' in reference(base, tmp / 'nope.urdf', tmp).get('reason', ''), 'a missing file is recorded')
        check(not reference(dict(base, format='usd'), tmp / 't.urdf', tmp)['ok'], 'an unhandled format is recorded')
        check(resolve_mesh('file:///abs/a.stl', str(tmp / 't.urdf'), {}) is None, 'file:// mesh paths never resolve')
        check(package_map(tmp) == {'tpkg': str(tmp)}, 'package.xml names are found')

        skipped = []
        if importlib.util.find_spec('xacro'):
            (tmp / 't.xacro').write_text(
                '<robot name="x" xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:arg name="n" default="2"/>'
                '<xacro:include filename="$(find tpkg)/inc.xacro"/><link name="l$(arg n)"/></robot>')
            (tmp / 'inc.xacro').write_text('<robot xmlns:xacro="http://www.ros.org/wiki/xacro"><link name="inc"/></robot>')
            r = reference(dict(base, format='xacro', xacro_args={'n': '7'}), tmp / 't.xacro', tmp)
            check(r['ok'] and r['links'] == 2, 'xacro expands $(find) from package.xml and takes xacro_args')
            (tmp / 'u.xacro').write_text('<robot xmlns:xacro="http://www.ros.org/wiki/xacro">'
                                         '<xacro:include filename="$(find nopkg)/a.xacro"/></robot>')
            check(not reference(dict(base, format='xacro'), tmp / 'u.xacro', tmp)['ok'], 'an unknown package fails')
        else:
            skipped.append('xacro')
        if importlib.util.find_spec('mujoco'):
            (tmp / 'm.xml').write_text('<mujoco><compiler angle="radian"/><worldbody><body><freejoint/><geom size="0.1"/><body>'
                                       '<joint type="hinge" axis="0 1 0" range="-1 1"/><geom size="0.1"/>'
                                       '</body></body></worldbody></mujoco>')
            r = reference(dict(base, format='mjcf'), tmp / 'm.xml', tmp)
            check(r['ok'] and r['bodies'] == 3 and [j['type'] for j in r['joints']] == ['free', 'hinge']
                  and r['joints'][1]['range'] == [-1.0, 1.0], 'an MJCF compiles and its joints are read')
            (tmp / 'mbad.xml').write_text('<mujoco><worldbody><geom type="nosuch"/></worldbody></mujoco>')
            check(not reference(dict(base, format='mjcf'), tmp / 'mbad.xml', tmp)['ok'], 'a bad MJCF is not ok')
        else:
            skipped.append('mujoco')

    failed = [what for ok, what in results if not ok]
    for what in failed:
        print('FAIL: ' + what, file=sys.stderr)
    note = f' (skipped: {", ".join(skipped)} not installed)' if skipped else ''
    print(f'reference: {len(results) - len(failed)} checks passed' + (f', {len(failed)} FAILED' if failed else '') + note)
    return 1 if failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='Record reference-tool results for the corpus models.')
    ap.add_argument('--lock', default=str(fetch.LOCK))
    ap.add_argument('--cache', default=str(fetch.DEFAULT_CACHE))
    ap.add_argument('--only', action='append', metavar='NAME')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    cache = Path(a.cache)
    try:
        models = fetch.load_lock(a.lock)
    except fetch.FetchError as exc:
        print(f'[reference] FAIL: {exc}', file=sys.stderr)
        return 1
    if fetch.inside(fetch.REPO_ROOT, cache):
        print('[reference] FAIL: the cache must be outside the repo', file=sys.stderr)
        return 1
    if a.only:
        models = [m for m in models if m['name'] in a.only]
    out = cache / 'reference'
    out.mkdir(parents=True, exist_ok=True)
    ok = 0
    for m in models:
        checkout = cache / fetch.checkout_name(m['repo'], m['commit'])
        rec = reference(m, checkout / m['path'], checkout)
        (out / f"{m['name']}.json").write_text(json.dumps(rec, indent=1) + '\n', encoding='utf-8')
        ok += rec['ok']
        print('[reference] ' + summary(rec))
    print(f'[reference] {ok}/{len(models)} models read; records in {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
