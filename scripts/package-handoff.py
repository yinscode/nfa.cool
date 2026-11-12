#!/usr/bin/env python3
"""Package reviewable sources, artwork and public release evidence only."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
excluded = {"node_modules", "target", "dist", "output", "deployments", ".data", ".deps", ".git", "__pycache__"}
destination = root / "nfa-handoff.zip"
files = []
for path in root.rglob("*"):
    relative = path.relative_to(root)
    if any(part in excluded for part in relative.parts):
        continue
    if path.is_symlink() or not path.is_file():
        continue
    if path.suffix == ".zip" or path.name.endswith((".key.json", ".signed.json", ".pem")):
        continue
    if path.name.startswith(".env") and path.name != ".env.example":
        continue
    files.append((path, relative))
with ZipFile(destination, "w", ZIP_DEFLATED, compresslevel=9) as archive:
    for path, relative in sorted(files):
        archive.write(path, Path("nfa") / relative)
with ZipFile(destination) as archive:
    assert archive.testzip() is None
    for entry in archive.namelist():
        assert not any(part in excluded for part in Path(entry).parts)
        assert not entry.endswith((".key.json", ".signed.json", ".pem"))
        assert b"-----BEGIN " + b"PRIVATE KEY-----" not in archive.read(entry), entry
print(f"{destination.name}: {len(files)} files, {destination.stat().st_size:,} bytes; verified")
