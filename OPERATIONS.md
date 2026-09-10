# Operating the pilot

Audience: the engineer responsible for a private demonstration. This guide covers local container operations. Use the [AWS runbook](infra/README.md) for the personal deployment, its security boundaries and billable resources.

## Production processes

[Dockerfile](Dockerfile) builds one image for the web process and worker. Runtime runs as unprivileged UID/GID `1000:1000`; commands invoke Node directly. Environment files are excluded from the image. The worker needs `ANTHROPIC_API_KEY` in its environment; a Linux container cannot read the Mac Keychain.

[compose.app.yaml](compose.app.yaml) defines an explicit migration job and starts web/worker only after that job succeeds. Supply the target `DATABASE_URL`, `DEMO_ACCESS_CODE`, `SESSION_SECRET`, `APP_ORIGIN`, and `ANTHROPIC_API_KEY` through a private environment. `ONE_DOOR_IMAGE` defaults to `one-door:local`; `APP_PORT` defaults to 3000.

The database must already exist and be reachable by the containers. In the development Compose network the database hostname is `postgres`, not `localhost`. A managed database needs its actual hostname and the provider's required TLS settings.

Validate configuration without printing secrets:

```sh
docker compose -f compose.app.yaml config --quiet
```

With the reviewed environment supplied, build and start the app:

```sh
docker compose -f compose.app.yaml up -d --build --wait
```

This command does not seed a database. Install reference fixtures separately on a fresh demo database before inviting users. The Compose file binds the web port to loopback; put an HTTPS reverse proxy in front of it for a hosted demo and pin `APP_ORIGIN` to the public HTTPS origin. Database credentials and the API key must never enter the client bundle.

Web health checks the database, not worker progress or provider access. Inspect worker logs and the saved job/usage records as well. A failing provider call must remain a failure; do not replace it with seeded success.

## Backup and restore

Back up PostgreSQL and preserve the signing secret securely outside the image. A database backup alone does not preserve the browser identity needed to resume private drafts. These local Compose instructions do not establish an automated schedule or off-host backup. The AWS deployment uses RDS backups; follow its runbook for recovery.

Choose the source database explicitly. The development default is `one_door`; use the database your running app actually uses. The commands below create a private, uniquely named archive directory and a fresh restore target. The `&&` chain stops on failure and never restores into an existing database.

```sh
backup_database=one_door
backup_directory=$(docker exec one-door-postgres mktemp -d /tmp/one-door-backup.XXXXXX) &&
restore_database=one_door_restore_$(node -p "require('node:crypto').randomBytes(6).toString('hex')") &&
docker exec one-door-postgres pg_dump -U one_door --dbname="$backup_database" --format=custom --file="$backup_directory/database.dump" &&
docker exec one-door-postgres chmod 600 "$backup_directory/database.dump" &&
docker exec one-door-postgres createdb -U one_door "$restore_database" &&
docker exec one-door-postgres pg_restore -U one_door --exit-on-error --dbname="$restore_database" "$backup_directory/database.dump"
```

Inspect the archive with `docker exec one-door-postgres pg_restore --list "$backup_directory/database.dump"`. Keep the source database unchanged. Both the archive and restored database remain until an operator explicitly removes them.

After restoring, apply the matching release's forward migrations to the restored database. Verify records and history before changing the app's database URL. A September 5, 2026 check on PostgreSQL 18.6 matched full-row digests for 26 requests, two content revisions, 32 task completions, ten RICE records, and four WIP rows. It also restored all six live model-call receipts that existed at backup time. Later evaluation calls were outside that checkpoint and were not claimed as restored.

That archive lives inside the development PostgreSQL container. It demonstrates restoration; it is not the off-host production backup policy.

## Updating and rollback

### Updating the application

Keep the current working image and take a verified backup before applying a release. Migrations are forward-only and checksum-protected; an applied migration must not be rewritten. A successful database migration does not by itself prove the web process, worker, or model transport works.

Application rollback can use the earlier image only if it remains compatible with the migrated schema. Otherwise restore a verified checkpoint into a new database and test the earlier release there before an operator switches traffic. A checkpoint rollback excludes writes made after that checkpoint; preserve the newer database for recovery rather than deleting it.

Fixture restoration is not a database rollback. It restores shared example state while preserving live requests, unfinished work, ratings, spend, and audit evidence. It can supersede work on fixture requests and therefore requires explicit confirmation. It does not reset model limits or remove the records of earlier decisions.

### Correcting an older set of demo examples

The current build includes an append-only upgrade for the known September 5 reference fixture. Choose the existing demo database explicitly, take a backup, and run:

```sh
npm run db:upgrade-fixtures -- --confirm-fixture-upgrade
```

The command adds corrected assessment evidence, missing review scores, and transcript reply links. Earlier evidence remains. Visitor-created requests and human-revised requests are not replaced with template values. A repeat reports that the examples already match; an unknown fixture version is refused rather than overwritten.

After upgrading, Administrator → Demo controls can restore the shared examples for another walkthrough. Restoration keeps visitor-created requests, saved work, ratings, model costs, and earlier evidence. The screen requires a fresh confirmation because other visitors may be using the same examples. It is not a database rollback or a model-quota reset.
