#!/usr/bin/env python3
"""Record what reference tools read from each corpus model, so ROCO's importers can be checked against them.

    python3 -I tools/corpus/reference.py [--only NAME ...] [--cache DIR] [--lock FILE] [--mutate]
    python3 -I tools/corpus/reference.py --self-test

Run it with an interpreter that has mujoco and xacro installed (pip), after tools/corpus/fetch.py. It writes one JSON
per model to <cache>/reference/<name>.json:
  - mjcf:  mujoco compiles the model; bodies, joints (type, axis, range), meshes, geoms and actuators;
  - urdf:  ElementTree; links, joints (type, parent, child, axis, limits) and mesh references, and how many of them
           resolve to a file (package:// names come from the checkout's package.xml files);
  - xacro: xacro expands the file with the lock's xacro_args, $(find pkg) resolved from the same package.xml map,
           then it is read as urdf;
  - sdf:   `gz sdf -p`, when gz is installed.
Every urdf, xacro and mjcf record also has `poses`: each named link's (body's) world position and quaternion
[w, x, y, z] with every joint at zero (MJCF: at qpos0), so an importer's frames can be checked to 1e-5.
Every urdf, xacro and mjcf record also has `mass_check`, MuJoCo's verdict on the model's masses and inertias, which
ROCO's model check (src/utils/modelChecker.ts) must agree with: {"ok": true} or {"ok": false, "error", "comparable"}.
An MJCF is compiled as it is; a URDF as an inertia-only copy (visuals dropped, collisions kept only on links whose mass
MuJoCo infers from them, collision meshes MuJoCo cannot read dropped and noted), so a mesh MuJoCo cannot read does not
hide the verdict. A refusal for anything but mass or inertia, or after a mesh was dropped, is "comparable": false.
--mutate also writes 3 mutants per model to <cache>/mutants/<name>/ (zero mass, an inertia that breaks A + B >= C, a
negative principal moment, each on the first moving link with an inertial) and records each one's verdict under
`mutants`.
A model that cannot be read is recorded as {"ok": false, "reason": ...}; that is data, not a crash. The run exits 0
once every model is recorded, and 1 only on a usage error.
"""
import argparse
import importlib.util
import json
import math
import os
import re
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


def quat_mul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw)


def quat_rotate(q, v):
    w, x, y, z = quat_mul(quat_mul(q, (0.0, *v)), (q[0], -q[1], -q[2], -q[3]))
    return (x, y, z)


def rpy_quat(r, p, y):
    """URDF rpy: fixed-axis roll about X, then pitch about Y, then yaw about Z, so q = qz * qy * qx."""
    qx = (math.cos(r / 2), math.sin(r / 2), 0.0, 0.0)
    qy = (math.cos(p / 2), 0.0, math.sin(p / 2), 0.0)
    qz = (math.cos(y / 2), 0.0, 0.0, math.sin(y / 2))
    return quat_mul(qz, quat_mul(qy, qx))


def pose_record(p, q):
    if q[0] < 0:                        # one sign per rotation, so records compare as text too
        q = tuple(-c for c in q)
    return {'xyz': [round(c, 9) for c in p], 'quat': [round(c, 9) for c in q]}


def urdf_poses(root):
    """World pose of every link reachable from a root link, every joint at zero: joint origins composed down the tree."""
    children = {}
    child_links = set()
    for j in root.findall('joint'):
        parent, child = j.find('parent'), j.find('child')
        if parent is None or child is None or not parent.get('link') or not child.get('link'):
            continue
        o = j.find('origin')
        xyz = [float(v) for v in (o.get('xyz', '0 0 0') if o is not None else '0 0 0').split()]
        rpy = [float(v) for v in (o.get('rpy', '0 0 0') if o is not None else '0 0 0').split()]
        children.setdefault(parent.get('link'), []).append((child.get('link'), xyz, rpy_quat(*rpy)))
        child_links.add(child.get('link'))
    names = [link.get('name') for link in root.findall('link') if link.get('name')]
    out = {}
    stack = [(n, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0)) for n in names if n not in child_links]
    while stack:
        name, p, q = stack.pop()
        if name in out:
            continue                    # a loop or a second parent: the first path wins, as in URDF loaders
        out[name] = pose_record(p, q)
        for child, xyz, oq in children.get(name, []):
            off = quat_rotate(q, xyz)
            stack.append((child, (p[0] + off[0], p[1] + off[1], p[2] + off[2]), quat_mul(q, oq)))
    return out


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
            'mesh_refs_missing': [r for r in refs if r not in found][:20], 'poses': urdf_poses(root)}


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
    d = mujoco.MjData(m)                 # qpos starts at qpos0
    mujoco.mj_kinematics(m, d)
    poses = {}
    for b in range(1, m.nbody):           # body 0 is the world
        name = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, b)
        if name:
            poses[name] = pose_record([float(x) for x in d.xpos[b]], [float(x) for x in d.xquat[b]])
    return {'tool': 'mujoco ' + mujoco.__version__, 'bodies': int(m.nbody), 'joints': joints, 'poses': poses,
            'movable_joints': sum(j['type'] != 'free' for j in joints), 'meshes': int(m.nmesh),
            'geoms': int(m.ngeom), 'actuators': int(m.nu)}


# MuJoCo 3.17.0's refusals of a body's mass or inertia (user_objects.cc mjCBody/mjCInertial, user_model.cc
# CheckBodyMassInertia): "mass and inertia of moving bodies must be larger than mjMINVAL", "mass and inertia cannot be
# negative", "inertia must have positive eigenvalues" and "inertia must satisfy A + B >= C; use 'balanceinertia' to fix".
MASS_ERROR = re.compile(r'mass and inertia|inertia must')
URDF_MOVING = ('revolute', 'continuous', 'prismatic', 'floating', 'planar')
MUJOCO_MESHES = ('.stl', '.obj', '.msh')
MUTANTS = ('zero-mass', 'triangle', 'negative-moment')


def compile_verdict(xml_text, notes=()):
    """MuJoCo's verdict on a model written out to a scratch file: {"ok": true} or why it refused, and whether that refusal
    is about mass or inertia with nothing dropped on the way ("comparable")."""
    import mujoco
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'model.xml'
        path.write_text(xml_text, encoding='utf-8')
        try:
            mujoco.MjModel.from_xml_path(str(path))
            out = {'ok': True}
        except Exception as exc:
            error = ' '.join(str(exc).split())[:400]
            out = {'ok': False, 'error': error, 'comparable': bool(MASS_ERROR.search(error)) and not notes}
    if notes:
        out['notes'] = list(notes)[:20]
    return out


def inertia_only_urdf(root, model_file, packages):
    """A copy of a URDF that MuJoCo can compile wherever it is written: visuals dropped; collisions kept only on links that
    have no <inertial> (or on every link under <compiler inertiafromgeom="true">), with their meshes at absolute paths, and
    a mesh MuJoCo cannot read dropped and noted."""
    root = ET.fromstring(ET.tostring(root))
    compilers = [c for m in root.findall('mujoco') for c in m.findall('compiler')]
    from_geom = any((c.get('inertiafromgeom') or '').strip().lower() == 'true' for c in compilers)
    notes = []
    for link in root.findall('link'):
        for v in link.findall('visual'):
            link.remove(v)
        keep = from_geom or link.find('inertial') is None
        for c in link.findall('collision'):
            mesh = c.find('geometry/mesh')
            if not keep:
                link.remove(c)
            elif mesh is not None:
                p = resolve_mesh(mesh.get('filename', ''), model_file, packages)
                if p and os.path.isfile(p) and p.lower().endswith(MUJOCO_MESHES):
                    mesh.set('filename', os.path.abspath(p))
                else:
                    link.remove(c)
                    notes.append(f"{link.get('name')}: collision mesh {mesh.get('filename')} dropped")
    if not compilers:
        compilers = [ET.SubElement(ET.SubElement(root, 'mujoco'), 'compiler')]
    for c in compilers:
        for k in ('meshdir', 'assetdir', 'texturedir'):
            c.attrib.pop(k, None)
        c.set('strippath', 'false')
    return ET.tostring(root, encoding='unicode'), notes


def mjcf_anywhere(root, model_file):
    """A copy of an MJCF whose asset folders and includes are absolute, so it compiles wherever it is written."""
    root = ET.fromstring(ET.tostring(root))
    base = os.path.dirname(os.path.abspath(model_file))
    compilers = root.findall('compiler') or [ET.SubElement(root, 'compiler')]
    for c in compilers:
        asset = c.get('assetdir', '')
        for k in ('meshdir', 'texturedir'):
            c.set(k, os.path.join(base, c.get(k, asset)))
        c.attrib.pop('assetdir', None)
    for inc in root.iter('include'):
        if inc.get('file'):
            inc.set('file', os.path.join(base, inc.get('file')))
    return ET.tostring(root, encoding='unicode')


def mass_check(fmt, root, model_file, packages=None):
    if fmt == 'mjcf':
        return compile_verdict(mjcf_anywhere(root, model_file))
    text, notes = inertia_only_urdf(root, model_file, packages or {})
    return compile_verdict(text, notes)


def mutant_target(fmt, root):
    """The first moving link (MJCF: body) that has an inertial with a mass and an inertia, or None."""
    if fmt == 'mjcf':
        for b in root.iter('body'):
            i = b.find('inertial')
            if any(ch.tag in ('joint', 'freejoint') for ch in b) and i is not None and i.get('mass') is not None and \
                    (i.get('diaginertia') or i.get('fullinertia')):
                return b, b.get('name') or '(unnamed body)'
        return None
    moving = {j.find('child').get('link') for j in root.findall('joint')
              if j.get('type') in URDF_MOVING and j.find('child') is not None}
    for link in root.findall('link'):
        if link.get('name') in moving and link.find('inertial/mass') is not None and link.find('inertial/inertia') is not None:
            return link, link.get('name')
    return None


def mutate(fmt, root, kind):
    """A copy of the model with one mutation on mutant_target's link, and that link's name; None when there is no target."""
    root = ET.fromstring(ET.tostring(root))
    found = mutant_target(fmt, root)
    if found is None:
        return None
    el, name = found

    def g(v):
        return f'{v:.9g}'
    if fmt == 'mjcf':
        i = el.find('inertial')
        vals = floats(i.get('diaginertia') or i.get('fullinertia') or '') or []
        s = sum(abs(v) for v in vals[:3]) / 3 if len(vals) >= 3 else 0
        s = s if s > 1e-9 else 1e-3
        if kind == 'zero-mass':
            i.set('mass', '0')
        elif kind == 'triangle':
            i.attrib.pop('fullinertia', None)
            i.set('diaginertia', f'{g(s)} {g(s)} {g(3 * s)}')
        else:
            for k in ('diaginertia', 'quat', 'axisangle', 'xyaxes', 'zaxis', 'euler'):   # fullinertia takes no orientation
                i.attrib.pop(k, None)
            i.set('fullinertia', f'{g(s)} {g(s)} {g(s)} {g(2 * s)} 0 0')
    else:
        inertia = el.find('inertial/inertia')
        vals = [abs(float(inertia.get(k) or 0)) for k in ('ixx', 'iyy', 'izz')]
        s = sum(vals) / 3
        s = s if s > 1e-9 else 1e-3
        if kind == 'zero-mass':
            el.find('inertial/mass').set('value', '0')
        elif kind == 'triangle':
            inertia.attrib.update(ixx=g(s), iyy=g(s), izz=g(3 * s), ixy='0', ixz='0', iyz='0')
        else:
            inertia.attrib.update(ixx=g(s), iyy=g(s), izz=g(s), ixy=g(2 * s), ixz='0', iyz='0')
    return root, name


def write_mutants(fmt, root, model_file, packages, out_dir):
    """Writes each mutant to out_dir as the file ROCO imports, and returns their records with MuJoCo's verdicts."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    records = []
    for kind in MUTANTS:
        m = mutate(fmt, root, kind)
        if m is None:
            break
        mroot, link = m
        file = f"{kind}.{'xml' if fmt == 'mjcf' else 'urdf'}"
        (out_dir / file).write_text(ET.tostring(mroot, encoding='unicode') + '\n', encoding='utf-8')
        records.append({'kind': kind, 'link': link, 'file': file, 'mass_check': mass_check(fmt, mroot, model_file, packages)})
    return records


def reference(model, model_file, checkout, mutate_to=None):
    """The reference record for one model. Never raises. With mutate_to (a folder), its mutants are written there too."""
    t0 = time.perf_counter()
    rec = {'name': model['name'], 'group': model['group'], 'format': model['format'], 'commit': model['commit'],
           'path': model['path']}
    try:
        if not Path(model_file).is_file():
            raise FileNotFoundError('model file is missing; run tools/corpus/fetch.py first')
        fmt = model['format']
        verdict = None
        if fmt == 'mjcf':
            rec.update(read_mjcf(model_file))
            verdict = ('mjcf', ET.parse(model_file).getroot(), None)
        elif fmt in ('urdf', 'xacro'):
            packages = package_map(checkout)
            if fmt == 'xacro':
                text, tool = expand_xacro(model_file, model.get('xacro_args', {}), packages)
            else:
                text, tool = Path(model_file).read_text(encoding='utf-8'), 'xml.etree'
            rec['tool'] = tool
            rec.update(read_urdf(text, model_file, packages))
            verdict = ('urdf', ET.fromstring(text), packages)
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
        if verdict and importlib.util.find_spec('mujoco'):
            kind, root, packages = verdict
            rec['mass_check'] = mass_check(kind, root, model_file, packages)
            if mutate_to is not None:
                rec['mutants'] = write_mutants(kind, root, model_file, packages, Path(mutate_to))
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
    mc = rec.get('mass_check')
    mass = '' if mc is None else '  mass ok' if mc['ok'] else f"  mass REFUSED{'' if mc['comparable'] else ' (not comparable)'}"
    mutants = ''.join(f"  {m['kind']} {'ok' if m['mass_check']['ok'] else 'refused'}" for m in rec.get('mutants', []))
    return f"{rec['name']:18} {rec['format']:5} ok    {size}{mass}{mutants}  [{rec['tool']}, {rec['seconds']} s]"


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
        check(r['ok'] and r['poses'] == {'a': pose_record((0, 0, 0), (1, 0, 0, 0)), 'b': pose_record((0, 0, 0), (1, 0, 0, 0)),
                                         'c': pose_record((0, 0, 0), (1, 0, 0, 0))}, 'joints with no origin leave links at the root')
        (tmp / 'fk.urdf').write_text(
            '<robot name="fk"><link name="a"/><link name="b"/><link name="c"/>'
            '<joint name="j1" type="revolute"><parent link="a"/><child link="b"/>'
            '<origin xyz="1 0 0" rpy="0 0 1.5707963267948966"/></joint>'
            '<joint name="j2" type="fixed"><parent link="b"/><child link="c"/><origin xyz="1 0 0" rpy="0.3 0.2 0.1"/></joint></robot>')
        fk = reference(base, tmp / 'fk.urdf', tmp).get('poses', {})
        h = math.sqrt(0.5)
        check(fk.get('b') == pose_record((1, 0, 0), (h, 0, 0, h)), 'a joint origin moves and turns its child')
        check(fk.get('c', {}).get('xyz') == [1.0, 1.0, 0.0], "a child's offset is turned by its parent's rotation")
        # rpy (0.3, 0.2, 0.1) is qz(0.1)*qy(0.2)*qx(0.3): w x y z worked by hand from the half-angle products
        cr, sr, cp, sp, cy, sy = math.cos(.15), math.sin(.15), math.cos(.1), math.sin(.1), math.cos(.05), math.sin(.05)
        rq = (cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy)
        check(fk.get('c', {}).get('quat') == pose_record((0, 0, 0), quat_mul((h, 0, 0, h), rq))['quat'],
              'rpy is roll, then pitch, then yaw about fixed axes')
        check(rpy_quat(0.3, 0.2, 0.1) != quat_mul(quat_mul(rpy_quat(0.3, 0, 0), rpy_quat(0, 0.2, 0)), rpy_quat(0, 0, 0.1)),
              'negative: the other rotation order gives a different quaternion')
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
            (tmp / 'mp.xml').write_text('<mujoco><compiler angle="degree"/><worldbody><body name="a" pos="1 0 0" euler="0 0 90">'
                                        '<geom size="0.1"/><body name="b" pos="1 0 0"><joint type="hinge"/><geom size="0.1"/>'
                                        '</body></body></worldbody></mujoco>')
            mp = reference(dict(base, format='mjcf'), tmp / 'mp.xml', tmp).get('poses', {})
            h = math.sqrt(0.5)
            check(mp.get('a') == pose_record((1, 0, 0), (h, 0, 0, h)) and mp.get('b', {}).get('xyz') == [1.0, 1.0, 0.0],
                  'MJCF body poses at qpos0 are recorded')
            (tmp / 'mbad.xml').write_text('<mujoco><worldbody><geom type="nosuch"/></worldbody></mujoco>')
            check(not reference(dict(base, format='mjcf'), tmp / 'mbad.xml', tmp)['ok'], 'a bad MJCF is not ok')

            # mass_check and the mutants
            inertial = '<inertial><mass value="1"/><inertia ixx="0.01" iyy="0.02" izz="0.02" ixy="0" ixz="0" iyz="0"/></inertial>'
            (tmp / 'mass.urdf').write_text(
                f'<robot name="m"><link name="a"/><link name="b">{inertial}<visual><geometry><mesh filename="meshes/a.stl"/>'
                '</geometry></visual><collision><geometry><mesh filename="meshes/gone.dae"/></geometry></collision></link>'
                '<link name="c"><collision><geometry><box size="0.1 0.1 0.1"/></geometry></collision>'
                '<collision><geometry><mesh filename="meshes/b.dae"/></geometry></collision></link>'
                '<joint name="j1" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 0 1"/>'
                '<limit lower="-1" upper="1" effort="1" velocity="1"/></joint>'
                '<joint name="j2" type="revolute"><parent link="b"/><child link="c"/><axis xyz="0 0 1"/>'
                '<limit lower="-1" upper="1" effort="1" velocity="1"/></joint></robot>')
            r = reference(base, tmp / 'mass.urdf', tmp, tmp / 'mut')
            check(r['ok'] and r['mass_check']['ok'] and r['mass_check']['notes'] == ['c: collision mesh meshes/b.dae dropped'],
                  'a sound URDF compiles inertia-only: visuals and the collisions of links with an inertial dropped, a .dae noted')
            only, _ = inertia_only_urdf(ET.parse(tmp / 'mass.urdf').getroot(), str(tmp / 'mass.urdf'), {})
            check('<visual' not in only and 'gone.dae' not in only and '<box' in only and 'strippath="false"' in only,
                  'the inertia-only copy keeps only the collisions MuJoCo infers mass from')
            muts = {m['kind']: m for m in r.get('mutants', [])}
            want = {'zero-mass': 'mass and inertia of moving bodies', 'triangle': 'A + B >= C',
                    'negative-moment': 'positive eigenvalues'}
            for kind, msg in want.items():
                mc = muts.get(kind, {}).get('mass_check', {})
                check(not mc.get('ok', True) and msg in mc.get('error', '') and muts[kind]['link'] == 'b'
                      and (tmp / 'mut' / f'{kind}.urdf').is_file(), f'URDF mutant {kind} on link b: MuJoCo says "{msg}"')
            check(mutate('urdf', ET.fromstring('<robot><link name="a"/></robot>'), 'zero-mass') is None,
                  'a model with no moving link that has an inertial has no mutant')
            (tmp / 'mass.xml').write_text(
                '<mujoco><worldbody><body name="a"><freejoint/><inertial pos="0 0 0" quat="0 1 0 0" mass="1" diaginertia="0.01 0.02 0.02"/>'
                '<body name="b"><joint/><geom size="0.1"/></body></body></worldbody></mujoco>')
            r = reference(dict(base, format='mjcf'), tmp / 'mass.xml', tmp, tmp / 'mutx')
            check(r['ok'] and r['mass_check'] == {'ok': True}, 'a sound MJCF passes the mass check')
            muts = {m['kind']: m for m in r.get('mutants', [])}
            for kind, msg in want.items():
                mc = muts.get(kind, {}).get('mass_check', {})
                check(not mc.get('ok', True) and msg in mc.get('error', '') and mc.get('comparable') and muts[kind]['link'] == 'a',
                      f'MJCF mutant {kind} on body a: MuJoCo says "{msg}"')
            (tmp / 'carried.xml').write_text(
                '<mujoco><worldbody><body name="a"><joint/><inertial pos="0 0 0" mass="1" diaginertia="0.01 0.02 0.02"/>'
                '<body name="b"><geom size="0.1"/></body></body></worldbody></mujoco>')
            r = reference(dict(base, format='mjcf'), tmp / 'carried.xml', tmp, tmp / 'mutc')
            check([m['mass_check']['ok'] for m in r.get('mutants', [])][:1] == [True],
                  'negative: zero mass on a body whose fixed child has mass is accepted, as MuJoCo does')
            bad = compile_verdict('<mujoco><worldbody><geom type="nosuch"/></worldbody></mujoco>')
            check(not bad['ok'] and not bad['comparable'], 'a refusal for anything but mass or inertia is not comparable')
            dropped = compile_verdict('<mujoco><worldbody><body><joint/></body></worldbody></mujoco>', ['x dropped'])
            check(not dropped['ok'] and not dropped['comparable'] and 'mjMINVAL' in dropped['error'],
                  'a mass refusal after a mesh was dropped is not comparable')
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
    ap.add_argument('--mutate', action='store_true', help='also write 3 mass and inertia mutants per model, with their verdicts')
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
        rec = reference(m, checkout / m['path'], checkout, cache / 'mutants' / m['name'] if a.mutate else None)
        (out / f"{m['name']}.json").write_text(json.dumps(rec, indent=1) + '\n', encoding='utf-8')
        ok += rec['ok']
        print('[reference] ' + summary(rec))
    print(f'[reference] {ok}/{len(models)} models read; records in {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
