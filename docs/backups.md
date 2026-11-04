# KG backups (`bin/kg-backup`)

Only two KG databases are persistent and non-reproducible; everything else (`kg_<release>_b<build>`, Solr `kg` core, parquet/KGX) is rebuilt by `make -C build`.

| db | holds | since |
|---|---|---|
| `kg_meta` | `releases` (current-build pointer per release), `publication_cache` (NCBI/Crossref enrichment, ~22k docs) | M1 |
| `kg_curation` | workspaces, assertions + revisions, review_events, attach_reports | M3 — see "kg_curation absent" below |

No other db is ever dumped (`DBS=(kg_meta kg_curation)` is hard-coded).

**kg_curation absent.** Until M3 the db does not exist. Every run then logs `WARN skip kg_curation: not present … and never backed up (pre-M3)` and still exits 0. That leniency is bounded:
- `KG_BACKUP_REQUIRE_CURATION=1` (env) or `--require-curation` makes absence a failure (`FAIL`, exit 1, the cron `logger` fallback fires). **Add it to the cron line once M3 lands** (see Cron). Any value other than `0`/`1` is a usage error (exit 2).
- Even without it, absence is a failure as soon as any `kg_curation-*.archive.gz` exists in the backup or weekly dir: once backed up, a missing db means it was lost, not that it has not been created yet.

## What a run does
Mongo: standalone `mongod` on `127.0.0.1:27017`, no auth. Tools pinned to `/usr/bin/{mongodump,mongorestore,mongosh}` (database-tools 100.13.0), `/usr/bin/{sha256sum,gzip,flock}`.

1. `flock -n` on `/scratch/olson/gramene-kg/backups/.kg-backup.lock` — an overlapping run fails immediately (exit 1).
2. Per present db: `mongodump --gzip --archive=<db>-<YYYYmmddTHHMMSS>.archive.gz.partial --db <db>`.
3. Verify the **`.partial`** before it gets its final name and before anything is pruned. The script takes the file's sha256 and runs `gzip -t`. Then `mongorestore -v --dryRun --gzip --archive=<archive>.partial --nsInclude '<db>.*'` must print `dry run completed`, plus `found collection <db>.<c> bson` for every non-system collection listed live just before the dump. The sidecar (sha256sum format, relative **final** name) goes to `<archive>.sha256.partial` and is read back. Finally the archive is re-hashed to confirm it did not change.
4. Commit: rename `<archive>.partial` → `<archive>`, then `<archive>.sha256.partial` → `<archive>.sha256` (same dir, atomic). Any failure in steps 2–4, a disk-full sidecar write included, removes both temp files. If only the first rename happened, it removes the archive too. So **nothing with a final name is left behind**.
   **Invariant: an archive is verified iff its `.sha256` sidecar exists (and `sha256sum -c` passes).** An archive without a sidecar can only be left over from a killed run (SIGKILL, power loss) or from the pre-fix script. Never restore from one. A `*.partial` left by a killed run does not match the prune pattern, so delete it by hand.
5. Prune `/scratch/olson/gramene-kg/backups/`. Candidates are only regular files whose basename matches `kg_(meta|curation)-[0-9]{8}T[0-9]{6}\.archive\.gz(\.sha256)?` and that `find -mtime +30` reports (> 30 days). The newest verified archive of each db (+ its sidecar) is **never pruned, whatever its age**, so a db that stops producing archives keeps its last good one. Nothing else in the dir is touched; no `rm -rf`.
6. Weekly copy of this run's archives + sidecars to `/home/olson/backups/gramene-kg/` on Sundays, or on any day when that dir has no matching file younger than 7 days. The same discipline applies: copy to `.partial` names, compare the copy's sha256 with the sidecar, then rename. The weekly dir is **not** pruned (≈3 MB/week today); thin it by hand if it ever matters.
7. Log to `/scratch/olson/gramene-kg/logs/backup.log` (incl. the full dryRun output). Any failure → a `FAIL: …` line and a non-zero exit. The FAIL line also goes to stderr, so a failing log append (e.g. disk full) does not hide the error.

`bin/kg-backup --dry-run` lists dbs/collections and prints the commands, the kept newest verified archives, the prune candidates and the weekly decision. It writes no archive and no log line (it does create the empty lock file). It does run the read-only `sha256sum -c` used to pick the kept archives.

## Cron (not installed — add with `crontab -e`)
```
30 2 * * * env -i HOME=/home/olson PATH=/usr/bin:/bin /usr/local/gramene/gramene-kg/bin/kg-backup >/dev/null 2>&1 || echo "kg-backup failed, see /scratch/olson/gramene-kg/logs/backup.log" | /usr/bin/logger -t kg-backup
```
Once M3 lands (kg_curation exists and has been backed up once), change `env -i HOME=/home/olson` to `env -i HOME=/home/olson KG_BACKUP_REQUIRE_CURATION=1`. Nothing else in the line changes.

Everything goes to `backup.log` already; the `logger` fallback leaves a syslog trace on failure (`journalctl -t kg-backup`). Paste this comment line above it — the M2 verify step is `crontab -l | grep kg_meta`, and cron lines cannot carry trailing comments:
```
# kg-backup: nightly mongodump of kg_meta + kg_curation -> /scratch/olson/gramene-kg/backups (docs/backups.md)
```

## Checking
```
ls -la /scratch/olson/gramene-kg/backups /home/olson/backups/gramene-kg
cd /scratch/olson/gramene-kg/backups && sha256sum -c kg_meta-*.sha256
for f in kg_*.archive.gz; do [ -f "$f.sha256" ] || echo "UNVERIFIED (no sidecar): $f"; done; ls *.partial 2>/dev/null
# newest VERIFIED archive (sidecar present and checks); never plain `ls | tail -1`
A=; for f in $(ls -1r /scratch/olson/gramene-kg/backups/kg_meta-*.archive.gz); do [ -f "$f.sha256" ] && (cd "$(dirname "$f")" && sha256sum --quiet -c "$(basename "$f").sha256") && { A=$f; break; }; done; echo "${A:?no verified kg_meta archive}"
/usr/bin/mongorestore -v --dryRun --gzip --archive=$A --nsInclude 'kg_meta.*'
grep -E 'FAIL|WARN|done' /scratch/olson/gramene-kg/logs/backup.log | tail
```

## Restore — always into a differently named db, never over a live one
`mongorestore` into an existing db merges/duplicates and `--drop` destroys the live copy; the API and build read `kg_meta` and write `kg_curation` continuously. Restore beside it, inspect, then swap deliberately.

```
# pick a VERIFIED archive only: it must have a .sha256 sidecar that checks (no sidecar = never verified, do not use).
# newest verified; to use an older one, set A by hand and still run the check line
A=; for f in $(ls -1r /scratch/olson/gramene-kg/backups/kg_meta-*.archive.gz); do [ -f "$f.sha256" ] && (cd "$(dirname "$f")" && sha256sum --quiet -c "$(basename "$f").sha256") && { A=$f; break; }; done; echo "${A:?no verified kg_meta archive}"
[ -f "$A.sha256" ] && (cd "$(dirname $A)" && sha256sum -c "$(basename $A).sha256") || echo "NOT VERIFIED - stop: $A"   # must print OK
grep -F " ok kg_meta $(basename $A) " /scratch/olson/gramene-kg/logs/backup.log   # runs since 2026-11-04 13:36 name the file on the ok line
# target must not exist yet (prints 0)
/usr/bin/mongosh --quiet --norc mongodb://127.0.0.1:27017/kg_meta_restore --eval 'print(db.getCollectionNames().length)'
/usr/bin/mongorestore --uri=mongodb://127.0.0.1:27017 --gzip --archive=$A \
  --nsInclude 'kg_meta.*' --nsFrom 'kg_meta.*' --nsTo 'kg_meta_restore.*'
# compare with live
/usr/bin/mongosh --quiet --norc mongodb://127.0.0.1:27017 --eval '
  const r=db.getSiblingDB("kg_meta_restore"), m=db.getSiblingDB("kg_meta");
  r.getCollectionNames().forEach(c=>print(c, r[c].countDocuments(), m[c].countDocuments()))'
```
If the local copies are gone, the weekly dir `/home/olson/backups/gramene-kg/` holds the same files under the same sidecar rule (use it in the picker).
Same for `kg_curation`: use `kg_curation-*` in the picker, and `--nsInclude 'kg_curation.*' --nsFrom 'kg_curation.*' --nsTo 'kg_curation_restore.*'`).

To actually roll back (rare; stop writers first — this is a deliberate operator action, not something a script does): first take a fresh `bin/kg-backup` (so the current state is archived too), then with `gramene-kg-api` stopped by the operator move collections one by one with `db.adminCommand({renameCollection:"kg_meta_restore.<c>", to:"kg_meta.<c>", dropTarget:true})`. Drop the scratch db when done: `db.getSiblingDB("kg_meta_restore").dropDatabase()`.

Verified 2026-11-04: `kg_meta-20261104T130928.archive.gz` restored into a scratch db with `--nsFrom/--nsTo` → 22293 docs (`releases` 1/1, `publication_cache` 22292/22292 vs live), then dropped.
