#!/usr/bin/env python3
"""170 · Guarda general de prefijos de migración (amplía check_smartmatch_migration_numbers.py).

Falla si una migración NUEVA (su nombre no existe en origin/main) usa un prefijo de 3 dígitos que ya existe
en origin/main, o que repite otra migración nueva. Los duplicados históricos que ya están en main (035, 037,
038, 051, 052, 066, 067, 068, 070, 081) no se tocan: solo se evalúan los archivos nuevos.

Uso: python3 scripts/check_migration_prefixes.py [ref_base]   (por defecto origin/main)
"""
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

PATTERN = re.compile(r"^(\d{3})_.*\.sql$")


def main_files(ref: str) -> list[str]:
    out = subprocess.run(["git", "ls-tree", "--name-only", f"{ref}:migrations"], capture_output=True, text=True)
    if out.returncode != 0:
        print(f"ERROR: no se pudo leer migrations/ en {ref}: {out.stderr.strip()}", file=sys.stderr)
        sys.exit(2)
    return [n for n in out.stdout.split() if PATTERN.match(n)]


def check(base: list[str], head: list[str]) -> list[str]:
    base_set = set(base)
    base_prefixes = {PATTERN.match(n).group(1) for n in base}
    new = sorted(n for n in head if PATTERN.match(n) and n not in base_set)
    errors = []
    for name in new:
        prefix = PATTERN.match(name).group(1)
        if prefix in base_prefixes:
            errors.append(f"{name}: el prefijo {prefix} ya existe en la rama base")
    counts = Counter(PATTERN.match(n).group(1) for n in new)
    for prefix, n in sorted(counts.items()):
        if n > 1:
            errors.append(f"prefijo {prefix} repetido en {n} migraciones nuevas")
    return errors


if __name__ == "__main__":
    ref = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    head = [p.name for p in Path("migrations").glob("*.sql")]
    errors = check(main_files(ref), head)
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"OK: prefijos de migración sin conflicto con {ref}")
