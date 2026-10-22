#!/usr/bin/env python3
"""Fail closed if a SmartMatch migration number is already occupied on main.

This checks the *name prefix*, not the file name, because migration runners
may order/apply by numeric prefix. Run from repository root with a fetched
origin/main. Never modify or apply a database migration from this script.
"""
from pathlib import Path
import subprocess
import sys

SMARTMATCH = ("078_", "079_", "080_", "081_")

def main() -> int:
    files = sorted(Path("migrations").glob("*.sql"))
    ours = [p.name for p in files if "smartmatch" in p.name.lower()]
    if not ours:
        print("ERROR: no SmartMatch migrations found", file=sys.stderr)
        return 2
    try:
        tracked = subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", "origin/main", "--", "migrations"],
            text=True,
        ).splitlines()
    except subprocess.CalledProcessError:
        print("ERROR: origin/main unavailable; refusing to guess migration safety", file=sys.stderr)
        return 2
    occupied = {Path(p).name[:4]: Path(p).name for p in tracked if p.endswith(".sql")}
    collisions = [(name, occupied[name[:4]]) for name in ours if name[:4] in occupied and occupied[name[:4]] != name]
    if collisions:
        for ours_name, main_name in collisions:
            print(f"BLOCKED: {ours_name} collides with main: {main_name}", file=sys.stderr)
        return 1
    if any(name.startswith("082_") for name in ours):
        print("BLOCKED: 082 is reserved for agency document privacy", file=sys.stderr)
        return 1
    print("SmartMatch migration prefixes do not conflict with origin/main")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
