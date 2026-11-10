#!/usr/bin/env python3
"""Builds the release wheel from a clone and tries it in a clean environment. CI runs it on every push and release.yml uses its output.

    python scripts/check_wheel.py [--out DIR]      needs dist/ (npm run build) and `pip install build`

It copies dist/ into scripts/roco_page/ (what the wheel carries), builds the wheel into DIR (default dist-py/), removes the copy again,
installs the wheel into a new virtual environment, and checks there that the packed page is found by the launcher, that the commands
`roco` and `roco-dds-bridge` exist, and that the launcher's own self-test passes. Exit code 1 when anything fails.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "scripts", "roco_page")

PROBE = """
import os, roco_page, roco_launcher
page = os.path.dirname(roco_page.__file__)
assert os.path.isfile(os.path.join(page, "index.html")), "the wheel has no page"
assert os.path.isfile(os.path.join(page, "demo", "g1-sample.rocodemo.gz")), "the wheel has no sample recording"
assert os.path.isdir(os.path.join(page, "models", "g1_description", "meshes_glb")), "the wheel has no robot models"
for name in ("LICENSE", "THIRD-PARTY-LICENSES.md"):
    assert os.path.isfile(os.path.join(page, name)), f"the wheel has no {name}"
assert roco_launcher.find_dist() == page, "the launcher does not find the packed page"
print("the wheel has the page, the sample, the models and the licences, and the launcher finds them")
"""


def clear_page():
    for name in os.listdir(PAGE):
        if name == "__init__.py":
            continue
        path = os.path.join(PAGE, name)
        shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.join(ROOT, "dist-py"))
    args = ap.parse_args()
    dist = os.path.join(ROOT, "dist")
    if not os.path.isfile(os.path.join(dist, "index.html")):
        print("check_wheel: no dist/, run npm run build first")
        return 1
    out = os.path.abspath(args.out)
    shutil.rmtree(out, ignore_errors=True)
    try:
        clear_page()
        shutil.copytree(dist, PAGE, dirs_exist_ok=True)
        subprocess.run([sys.executable, "-m", "build", "--wheel", "--outdir", out, ROOT], check=True)
    finally:
        clear_page()
        shutil.rmtree(os.path.join(ROOT, "build"), ignore_errors=True)
        for egg in glob.glob(os.path.join(ROOT, "scripts", "*.egg-info")):
            shutil.rmtree(egg, ignore_errors=True)
    wheels = glob.glob(os.path.join(out, "*.whl"))
    if len(wheels) != 1:
        print(f"check_wheel: expected one wheel in {out}, found {len(wheels)}")
        return 1
    print(f"check_wheel: built {os.path.basename(wheels[0])} ({os.path.getsize(wheels[0]) / 1048576:.1f} MB)")
    with tempfile.TemporaryDirectory() as tmp:
        venv = os.path.join(tmp, "venv")
        subprocess.run([sys.executable, "-m", "venv", venv], check=True)
        bindir = os.path.join(venv, "bin")
        subprocess.run([os.path.join(bindir, "pip"), "install", "-q", wheels[0]], check=True)
        # -I and a neutral folder: the clone's scripts/ must not be what gets imported
        run = lambda *cmd: subprocess.run(cmd, cwd=tmp, check=True)  # noqa: E731
        run(os.path.join(bindir, "python"), "-I", "-c", PROBE)
        run(os.path.join(bindir, "roco-dds-bridge"), "--help")
        run(os.path.join(bindir, "roco"), "--self-test")
    print("check_wheel: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
