#!/bin/sh
# Nightly consistent copy of the database while the watcher keeps writing (WAL + VACUUM INTO).
# Run from the repository root; DB_PATH from .env or the default.
#
# Two kept, not seven. A snapshot is the size of the database and the database grows about 300 MB a
# day, so seven of them outgrow a 40 GB disk within weeks and take the live database down with them.
# Raise SNAPSHOT_KEEP once the disk is bigger or retention (roadmap item 12) lands.
set -eu
cd "$(dirname "$0")/.."
DB="${DB_PATH:-data/rekt.db}"
DAY="$(date -u +%Y%m%d)"
mkdir -p data/snapshots
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const [db, out] = process.argv.slice(1);
const d = new DatabaseSync(db, { readOnly: true });
d.exec(`VACUUM INTO '"'"'${out}'"'"'`);
d.close();
console.log(`snapshot ${out}`);
' "$DB" "data/snapshots/rekt-$DAY.db"
KEEP="${SNAPSHOT_KEEP:-2}"
ls -1t data/snapshots/rekt-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# A snapshot that would leave less than 5 GB free is worse than no snapshot: the watcher writes to
# the same disk. Say so loudly rather than filling it.
FREE_MB="$(df -Pm . | awk 'NR==2 {print $4}')"
[ "$FREE_MB" -gt 5000 ] || echo "snapshot: only ${FREE_MB} MB free, raise the disk or lower SNAPSHOT_KEEP" >&2
