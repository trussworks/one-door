# One Door

One Door helps someone describe a software or infrastructure need, find a service path, and follow the request through review and delivery. Requesters, reviewers, and catalog stewards work on the same saved records.

This is an unreleased working pilot. Inventory, policies, and external delivery systems are fictional; application actions use PostgreSQL, and model preparation calls the paid Anthropic API. The shared access code is a demo gate, not agency identity management. Use fictional information only.

These instructions are for an engineer with access to this private repository who knows Node.js and Docker. Start in the repository root. The [implementation status](IMPLEMENTATION_STATUS.md) identifies remaining release work.

## Run locally

Prerequisites:

| Requirement    | Version for this setup | Check                    |
| -------------- | ---------------------- | ------------------------ |
| Node.js        | 24.x                   | `node --version`         |
| npm            | 11.x                   | `npm --version`          |
| Docker Engine  | 24 or newer            | `docker version`         |
| Docker Compose | 2.20 or newer          | `docker compose version` |

[Node.js installation](https://nodejs.org/en/download) and [Docker installation](https://docs.docker.com/get-started/get-docker/) cover installing those tools. An Anthropic API account with credit is needed for model-assisted intake and assessment; an agent subscription alone is not that account.

1. Install the locked dependencies.

   ```sh
   npm ci
   ```

2. Create a private local configuration before starting the database. If `.env` or `.env.local` already exists, keep that configuration instead: confirm privately that the web process, worker and database use the same credentials. The command below refuses to create a conflicting configuration.

   ```sh
   npm run setup:env
   ```

   The command reports `Created .env with private database and demo credentials.` It generates separate random credentials, writes `.env` with owner-only permissions, and prints no values. Open `.env` privately in your editor when you need the demo access code. Do not paste the file into chat, logs, or a commit. [.env.example](.env.example) lists the settings without supplying credentials.

   On macOS, an empty `ANTHROPIC_API_KEY` uses the Keychain service `anthropic-api`. Elsewhere, supply the key through the process environment or private `.env` file. Keep the key out of source control, logs, and browser code.

   Scripts load `.env`; Next.js also loads `.env.local`. An existing process environment variable wins over both. Check which database you intend to use before migration, seeding, or a test. Do not use a development database for integration tests.

3. Start the local database and wait for its health check.

   ```sh
   npm run db:up
   ```

   This starts `one-door-postgres` on loopback port 5432. [compose.yaml](compose.yaml) keeps its data in a named Docker volume. The generated connection URL and container use the same private password. An existing database keeps its original password. Changing `.env` alone does not rotate a database credential.

4. Apply migrations and install the reference fixture.

   ```sh
   npm run db:migrate
   ```

   ```sh
   npm run db:seed
   ```

   Migration reports the number applied. Seeding reports the installed reference counts; a repeat with the same fixture reports `Reference fixture already matches; no rows changed.` A different installed manifest is refused rather than replaced.

5. Start the web process, keeping it on this machine.

   ```sh
   npm run dev -- --hostname 127.0.0.1
   ```

6. In another terminal in the same directory, start the worker. This enables billable model calls for queued requests.

   ```sh
   npm run worker
   ```

   The worker prints `model worker ready; database verified` after checking its database. Both processes must use the same database. Do not start a worker against an integration-test database.

Open [One Door](http://127.0.0.1:3000/) and choose a workflow, then enter the access code. The [health endpoint](http://127.0.0.1:3000/api/health) returns `{"status":"ok"}` only after its database query succeeds; it does not certify model credentials or an external connection.

Other local run modes use the [ports listed in Development](DEVELOPMENT.md#local-ports).

### First request

Choose Requester, then Start a new request. Use this fictional need: “The Budget Office needs to deploy its forecasting application to Colorado Azure. Staff need agency sign-in, a managed database, monitoring, and a tested restore path.”

Answer the relevant questions, review the proposed summary and fit, and submit with a task rating. A request number appears in My requests. Switch to Reviewer without signing out; select Needs a coordinator to find unassigned work. Administrator → All requests shows the whole queue. RICE (Reach, Impact, Confidence, Effort) ranks requests using human estimates and deterministic arithmetic, not a model-generated score. Model wording and request numbers vary; the actual app and persistence are exercised by [browser acceptance](test/browser.acceptance.ts).

## Data, cost, and recovery

The worker sends request content and the applicable fictional service, asset, or policy records to Anthropic. It makes no ServiceNow or Azure DevOps tenant writes. Limits are defined in [models/jobs.ts](src/models/jobs.ts): per-browser and global daily calls, plus a monthly allowance. Reservations remain counted when actual usage is unknown. These limits belong to this application's database, not the entire Anthropic account.

Use the same browser to resume private drafts. Keep the signing secret stable and back it up securely: losing that secret or clearing the visitor cookie can prevent access to an existing private draft. Submitted requests remain available in the shared reviewer view.

Stop the web and worker with Ctrl-C. Stop PostgreSQL without deleting its volume:

```sh
docker compose stop postgres
```

The [operations guide](OPERATIONS.md) covers container startup, backup, restoration, and release boundaries. Restore into a new database first; do not erase the working database to test recovery.

## Troubleshooting

| Symptom                                            | Meaning and next action                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The demo access settings are not configured        | Set the access code and signing secret, then restart the web process.                                                                                   |
| Worker says the database has no `model_jobs` table | Verify `DATABASE_URL` and run migrations against that database before restarting the worker.                                                            |
| A draft stays in preparation                       | Confirm the worker is running against the web process's database. Inspect the saved job state; failed and capped work is not a successful empty result. |
| A model usage limit is reached                     | Inspect Model usage in Reports. Do not rewrite receipts or reset a database to bypass the limit.                                                        |
| The installed reference fixture differs            | Preserve the database. Use a fresh database for a different fixture, or investigate the version mismatch before considering fixture restoration.        |
| A newer change was saved                           | The form retains the unsaved entries. Load the current record, review the change, and explicitly choose whether to keep those entries.                  |

For a problem not covered here, report the failing command or request and its sanitized error to the project maintainer through this private repository. Do not include API keys, access codes, signing secrets, cookies, or database credentials.

## Development and scope

See [DEVELOPMENT.md](DEVELOPMENT.md) for checks and test-database isolation. Human design review and OIT user research remain separate from automated verification. This pilot is not an authorized procurement process, a security authorization, or a production agency service.

No project license is currently declared. Dependencies retain their own licenses.
