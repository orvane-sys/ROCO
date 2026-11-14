#!/usr/bin/env python3
"""Privacy scan for a change before it is handed over for commit (stdlib only, read-only on the repo).

    python3 -I tools/gate/privacy_scan.py --words FILE [--base REV] [--allow-image PATH ...]
    python3 -I tools/gate/privacy_scan.py --self-test

It reads the added lines of `git diff <base>` (tracked changes, staged or not) and every untracked file that git does not
ignore, except plans/. It flags:
  - the private words listed in FILE (one per line, `#` starts a comment; matched case-insensitively, as whole words). A
    hit names only the word's line number in FILE, never the word. FILE must be outside the repo, or inside it in a place
    git ignores and does not track (private/ in this repo);
  - email addresses, except the allow-list below;
  - IPv4 addresses, except loopback, 0.0.0.0, the documentation ranges and DDS's default multicast address;
  - MAC addresses;
  - home folder paths: a name under /home, /Users or C:\\Users;
  - this machine's host name and user name, read when it runs;
  - new or changed images (each must be approved with --allow-image), and any EXIF or PNG text chunk in them;
  - new recordings and corpus files: .mcap, .db3, .bag, .rocodemo(.gz), and .csv outside docs/.
Exit codes: 0 clean, 1 at least one hit, 2 a usage error (no --words, a words file inside the repo that git could commit,
not a git repo).
"""

import argparse
import contextlib
import getpass
import io
import ipaddress
import os
import re
import socket
import subprocess
import sys
import tempfile
from typing import Iterable, List, Optional, Sequence, Tuple

EMAIL_ALLOW = {"noreply@anthropic.com", "rocomaintainers@gmail.com", "49699333+dependabot[bot]@users.noreply.github.com"}
EMAIL_ALLOW_SUFFIX = ("@users.noreply.github.com",)
IP_ALLOW = {"127.0.0.1", "0.0.0.0", "239.255.0.1"}
IP_ALLOW_NETS = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
MAC_ALLOW = {"00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"}
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".ico")
RECORDING_EXT = (".mcap", ".db3", ".bag", ".rocodemo", ".rocodemo.gz")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-\[\]]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
MAC_RE = re.compile(r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])")
HOME_RE = re.compile(r"/(?:home|Users)/[^/\s\"'`]+/|[A-Za-z]:\\\\?Users\\\\?[^\\\s\"'`]+")


class Hit:
    def __init__(self, kind: str, where: str, detail: str = ""):
        self.kind, self.where, self.detail = kind, where, detail

    def __str__(self) -> str:
        return f"{self.kind}: {self.where}" + (f" ({self.detail})" if self.detail else "")


def load_words(path: str) -> List[Tuple[int, str]]:
    """(line number, word) for each non-empty, non-comment line, lower case."""
    out = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            w = line.strip()
            if w and not w.startswith("#"):
                out.append((n, w.lower()))
    return out


def inside(path: str, folder: str) -> bool:
    p, d = os.path.realpath(path), os.path.realpath(folder)
    return p == d or p.startswith(d.rstrip(os.sep) + os.sep)


def ip_allowed(text: str) -> bool:
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return True                       # not an address (e.g. 999.1.1.1): not a hit
    return text in IP_ALLOW or any(ip in n for n in IP_ALLOW_NETS)


def email_allowed(text: str) -> bool:
    t = text.lower()
    return t in EMAIL_ALLOW or t.endswith(EMAIL_ALLOW_SUFFIX)


def scan_line(line: str, where: str, words: Sequence[Tuple[int, str]], host: str, user: str) -> List[Hit]:
    hits = []
    low = line.lower()
    for n, w in words:
        # whole words only, so a short word does not hit inside a longer one; "_" and "-" count as word breaks
        if re.search(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", low):
            hits.append(Hit("private word", where, f"word #{n}"))
    for m in EMAIL_RE.finditer(line):
        if not email_allowed(m.group(0)):
            hits.append(Hit("email address", where))
    for m in IPV4_RE.finditer(line):
        if not ip_allowed(m.group(0)):
            hits.append(Hit("IP address", where))
    for m in MAC_RE.finditer(line):
        if m.group(0).lower().replace("-", ":") not in MAC_ALLOW:
            hits.append(Hit("MAC address", where))
    if HOME_RE.search(line):
        hits.append(Hit("home folder path", where))
    if host and re.search(rf"(?<![\w-]){re.escape(host)}(?![\w-])", line, re.I):
        hits.append(Hit("this machine's host name", where))
    if user and re.search(rf"(?<![\w-]){re.escape(user)}(?![\w-])", line, re.I):
        hits.append(Hit("this machine's user name", where))
    return hits


def image_metadata(data: bytes) -> List[str]:
    """Names of metadata blocks in a PNG or JPEG: PNG tEXt/zTXt/iTXt/eXIf chunks, JPEG APP1 Exif or XMP."""
    found = []
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        i = 8
        while i + 8 <= len(data):
            n = int.from_bytes(data[i:i + 4], "big")
            kind = data[i + 4:i + 8]
            if kind in (b"tEXt", b"zTXt", b"iTXt", b"eXIf"):
                found.append("PNG " + kind.decode())
            if kind == b"IEND":
                break
            i += 12 + n
    elif data.startswith(b"\xff\xd8"):
        if b"Exif\x00\x00" in data[:65536]:
            found.append("JPEG Exif")
        if b"http://ns.adobe.com/xap/1.0/" in data[:65536]:
            found.append("JPEG XMP")
    return found


def classify_file(rel: str, data: Optional[bytes], allow_images: Iterable[str]) -> List[Hit]:
    """Hits that depend on the file itself rather than its text: images and recordings."""
    hits = []
    low = rel.lower()
    if low.endswith(IMAGE_EXT):
        meta = image_metadata(data or b"")
        if meta:
            hits.append(Hit("image metadata", rel, ", ".join(meta)))
        if rel not in set(allow_images):
            hits.append(Hit("new or changed image (needs the user's approval: --allow-image)", rel))
    if low.endswith(RECORDING_EXT):
        hits.append(Hit("recording or corpus file", rel))
    elif low.endswith(".csv") and not low.startswith("docs/"):
        hits.append(Hit("CSV outside docs/", rel))
    return hits


def is_text(data: bytes) -> bool:
    return b"\x00" not in data[:8192]


def scan_text(rel: str, text: str, words, host, user, numbers: Optional[Sequence[int]] = None) -> List[Hit]:
    hits = []
    for i, line in enumerate(text.splitlines()):
        hits += scan_line(line, f"{rel}:{numbers[i] if numbers else i + 1}", words, host, user)
    return hits


def git(repo: str, *args: str) -> str:
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def ignored_untracked(repo: str, path: str) -> bool:
    """True when git ignores `path` and does not track it, so it cannot be committed by a plain `git add`.
    `git check-ignore` never reports a tracked file as ignored, so this one call covers both."""
    r = subprocess.run(["git", "-C", repo, "check-ignore", "-q", "--", os.path.realpath(path)], capture_output=True)
    return r.returncode == 0


def diff_added(repo: str, base: str) -> List[Tuple[str, List[Tuple[int, str]]]]:
    """(path, [(new line number, text)]) for the lines `git diff <base>` adds."""
    out, cur, n = [], None, 0
    for line in git(repo, "diff", "--no-color", "--no-ext-diff", "-U0", base).splitlines():
        if line.startswith("+++ "):
            cur = None if line[4:] == "/dev/null" else (line[6:] if line.startswith("+++ b/") else line[4:])
            if cur is not None:
                out.append((cur, []))
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            n = int(m.group(1)) if m else 0
        elif line.startswith("+") and cur is not None:
            out[-1][1].append((n, line[1:]))
            n += 1
    return out


def scan_repo(repo: str, base: str, words, host: str, user: str, allow_images: Iterable[str]) -> Tuple[List[Hit], List[str]]:
    hits, notes = [], []
    for rel, lines in diff_added(repo, base):
        if rel.startswith("plans/"):
            continue
        for n, text in lines:
            hits += scan_line(text, f"{rel}:{n}", words, host, user)
    changed = [p for p in git(repo, "diff", "--name-only", "--diff-filter=AMR", base).splitlines() if p]
    untracked = [p for p in git(repo, "ls-files", "--others", "--exclude-standard").splitlines() if p]
    if any(p.startswith("plans/") for p in untracked):
        notes.append("plans/ is untracked; never stage it")
    for rel in changed + untracked:
        if rel.startswith("plans/"):
            continue
        path = os.path.join(repo, rel)
        if os.path.islink(path):
            hits.append(Hit("symlink", rel, "points to " + os.readlink(path)))
            continue
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        hits += classify_file(rel, data, allow_images)
        if rel in untracked and is_text(data):
            hits += scan_text(rel, data.decode("utf-8", "replace"), words, host, user)
    return hits, notes


def self_test() -> int:
    results = []

    def check(ok: bool, what: str) -> None:
        results.append((bool(ok), what))

    words = [(3, "zebrafoo")]
    host, user = "testhost-7", "tuser"
    kinds = lambda line: [h.kind for h in scan_line(line, "f:1", words, host, user)]   # noqa: E731
    at = "@"
    check(kinds("a ZebraFoo here") == ["private word"], "a private word hits, case-insensitively")
    check(str(scan_line("zebrafoo", "f:1", words, "", "")[0]) == "private word: f:1 (word #3)", "a word hit names its number, not the word")
    check(kinds(f"mail jo{at}example.com") == ["email address"], "an email address hits")
    check(kinds(f"noreply{at}anthropic.com rocomaintainers{at}gmail.com 1+x{at}users.noreply.github.com") == [], "allow-listed emails pass")
    check(kinds("peer 10.1.2" ".3") == ["IP address"], "a private IPv4 address hits")
    check(kinds("127.0.0.1 0.0.0.0 192.0.2.7 198.51.100.1 203.0.113.9 239.255.0.1") == [], "loopback, doc ranges and DDS multicast pass")
    check(kinds("version 0.10.2 and 999.1.2.3") == [], "versions and non-addresses pass")
    check(kinds("nic 3c:52:82" ":aa:bb:01") == ["MAC address"], "a MAC address hits")
    check(kinds("00:00:00:00:00:00 and 12:30:45") == [], "an all-zero MAC and a time pass")
    check(kinds("/ho" "me/somebody/x") == ["home folder path"], "a /home path hits")
    check(kinds("/Us" "ers/somebody/x") == ["home folder path"] and kinds("C:\\" "Users\\somebody") == ["home folder path"], "macOS and Windows home paths hit")
    check(kinds("~/unitree_mujoco and /opt/ros/humble") == [], "~ and system paths pass")
    check(kinds("ssh testhost-7") == ["this machine's host name"], "the host name hits")
    check(kinds("by tuser today") == ["this machine's user name"] and kinds("tusers") == [], "the user name hits as a whole word only")
    png = b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + bytes(17) + (4).to_bytes(4, "big") + b"tEXt" + b"a\x00bc" + bytes(4) + bytes(4) + b"IEND" + bytes(4)
    check(image_metadata(png) == ["PNG tEXt"], "a PNG text chunk is found")
    check(image_metadata(b"\xff\xd8\xff\xe1\x00\x10Exif\x00\x00rest") == ["JPEG Exif"], "JPEG Exif is found")
    check([h.kind for h in classify_file("docs/a.png", png, [])] == ["image metadata", "new or changed image (needs the user's approval: --allow-image)"], "a new image needs approval")
    check([h.kind for h in classify_file("docs/a.png", png[:33] + b"\x00\x00\x00\x00IEND" + bytes(4), ["docs/a.png"])] == [], "an approved image with no metadata passes")
    check(all(classify_file(f"x{e}", b"", []) for e in RECORDING_EXT), "recordings hit")
    check(classify_file("tools/x.csv", b"", []) and not classify_file("docs/x.csv", b"", []), "a CSV hits outside docs/ only")

    # End to end in a throwaway git repo (untracked files only; nothing is committed anywhere)
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "r")
        os.mkdir(repo)
        subprocess.run(["git", "init", "-q", repo], check=True)
        empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        os.makedirs(os.path.join(repo, "plans"))
        with open(os.path.join(repo, "plans", "p.md"), "w") as f:
            f.write("zebrafoo\n")
        with open(os.path.join(repo, "ok.md"), "w") as f:
            f.write("clean text\n")
        hits, notes = scan_repo(repo, empty_tree, words, host, user, [])
        check(not hits and notes == ["plans/ is untracked; never stage it"], "a clean repo passes, plans/ is skipped with a warning")
        with open(os.path.join(repo, "bad.md"), "w") as f:
            f.write("line\nzebrafoo\n")
        hits, _ = scan_repo(repo, empty_tree, words, host, user, [])
        check([str(h) for h in hits] == ["private word: bad.md:2 (word #3)"], "an untracked file is scanned with line numbers")
        wfile = os.path.join(repo, "words.txt")
        with open(wfile, "w") as f:
            f.write("x\n")
        check(main(["--words", wfile, "--base", empty_tree], repo=repo) == 2, "a words file inside the repo that git does not ignore is refused")
        with open(os.path.join(tmp, "w.txt"), "w") as f:
            f.write("x\n")
        with contextlib.redirect_stderr(io.StringIO()):
            check(main(["--words", os.path.join(tmp, "w.txt"), "--base", "no-such-rev"], repo=repo) == 2, "an unknown --base is a usage error")
        os.remove(wfile)
        with open(os.path.join(repo, ".gitignore"), "w") as f:
            f.write("/private/\n")
        os.makedirs(os.path.join(repo, "private"))
        wfile = os.path.join(repo, "private", "words.txt")
        with open(wfile, "w") as f:
            f.write("x\n")
        with contextlib.redirect_stdout(io.StringIO()):
            check(main(["--words", wfile, "--base", empty_tree], repo=repo) == 0, "a words file that git ignores and does not track is accepted")
            subprocess.run(["git", "-C", repo, "add", "-f", wfile], check=True)
            check(main(["--words", wfile, "--base", empty_tree], repo=repo) == 2, "a words file that is tracked is refused, even if ignored")
    check(kinds("zebrafoos, xzebrafoo and zebrafoo1") == [], "a word inside a longer word does not hit")
    check(kinds("ZEBRAFOO_HOLD") == ["private word"] and kinds("zebrafoo's (zebrafoo-x)") == ["private word"], "a word next to _, - or punctuation hits")
    failed = [w for ok, w in results if not ok]
    for w in failed:
        print("FAIL: " + w)
    print(f"privacy_scan: {len(results) - len(failed)} checks passed" + (f", {len(failed)} FAILED" if failed else ""))
    return 1 if failed else 0


def main(argv: Sequence[str], repo: Optional[str] = None) -> int:
    ap = argparse.ArgumentParser(description="privacy scan of the uncommitted change")
    ap.add_argument("--words", help="file of private words, one per line, outside the repo or in an ignored, untracked place in it")
    ap.add_argument("--base", default="HEAD", help="revision to diff against (default HEAD)")
    ap.add_argument("--allow-image", action="append", default=[], metavar="PATH", help="an image the user approved (repo-relative)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        return self_test()
    if repo is None:
        try:
            repo = git(os.getcwd(), "rev-parse", "--show-toplevel").strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            print("privacy_scan: not inside a git repo", file=sys.stderr)
            return 2
    if not args.words:
        print("privacy_scan: --words FILE is required (for example private/privacy-words.txt)", file=sys.stderr)
        return 2
    if inside(args.words, repo) and not ignored_untracked(repo, args.words):
        print("privacy_scan: a words file inside the repo must be ignored by git and not tracked", file=sys.stderr)
        return 2
    try:
        words = load_words(args.words)
    except OSError as e:
        print(f"privacy_scan: cannot read the words file: {e.strerror}", file=sys.stderr)
        return 2
    try:
        hits, notes = scan_repo(repo, args.base, words, socket.gethostname(), getpass.getuser(), args.allow_image)
    except subprocess.CalledProcessError:
        print(f"privacy_scan: git cannot diff against '{args.base}'", file=sys.stderr)
        return 2
    for n in notes:
        print("note: " + n)
    for h in hits:
        print(h)
    print(f"privacy_scan: {len(hits)} hit(s), {len(words)} private words checked")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
