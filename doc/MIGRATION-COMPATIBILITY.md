# Migration compatibility for rolling replacement (SCO-877)

During a blue/green overlap the outgoing server runs against the schema the incoming server
migrated. A migration is safe for overlap only if code from the previous release keeps working.

## Rule: expand, then contract
- Expand release: add nullable or defaulted columns, new tables, new indexes (use
  `CREATE INDEX CONCURRENTLY` on large tables). Never in the same release as the code that stops using the old shape.
- Contract release (a later deploy, after no server runs the old code): drop columns/tables, add `NOT NULL`,
  add `CHECK`/`UNIQUE`/FK constraints or triggers that reject what old code still writes, rename.
- Never rename or retype in place; add the new column, dual-write, backfill, switch reads, then drop.

## Audit of migrations 0401-0432 (scripted scan, then read of the flagged ones)
- No `DROP TABLE`, `DROP COLUMN`, `RENAME`, `SET NOT NULL` or `ALTER COLUMN ... TYPE` in any of them. The
  recent history is already expand-shaped; only constraints and triggers need care.
- All `ADD COLUMN ... NOT NULL` carry a `DEFAULT` (none found without one), so old inserts keep working.
- Overlap-risky (old code can fail against the new schema):
  - 0428 adds a CHECK and an immutability trigger on `execution_admissions.admitted_project_ids`. Old code
    that updates that column after admission now errors. Treat as a contract step: deploy it only after the
    code that writes the column once is the only code running.
  - 0426 / 0415 / 0417 / 0418 / 0419 / 0421 / 0422 / 0429: new FKs, unique constraints or triggers on new
    tables or on nullable new columns. Low risk (old code never writes the new tables or columns).
  - 0432 `projects_company_issue_prefix_uq` is a partial unique index on a new nullable column: safe.
- Index builds: 0404/0405/0416-0432 create indexes without `CONCURRENTLY` (blocking writes briefly on
  small tables). Acceptable on tables of this size; large tables (`heartbeat_runs`, `issue_comments`,
  `activity_log`) should use `CONCURRENTLY` (the runner already supports it via
  `MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS`).

## Procedure for each deploy that migrates
1. Classify every new migration: expand (overlap-safe) or contract (needs the old server gone).
2. An expand-only release can roll with overlap. A release holding a contract migration waits one release,
   or runs as a stop-start (SCO-817 drain).
3. The incoming server migrates while it waits for scheduler leadership (migrations hold their own
   advisory lock, `paperclip:migrations`).
