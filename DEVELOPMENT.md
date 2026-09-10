# Development checks

Run the normal checks from the repository root:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run security
npm run security:history
npm audit --audit-level=high
```

The maintained command list is in [package.json](package.json), and [Harness CI](.github/workflows/harness-ci.yml) runs the configured checks. Do not disable a guardrail to make a change pass. New behavior needs a runnable check; a bug fix needs a regression check.

## Git hooks

`npm run prepare` points `core.hooksPath` at [.githooks](.githooks), so `.git/hooks` is never consulted. Three hooks there run the credential scanner: `pre-commit` scans the staged index, `commit-msg` scans the message that would be committed, and `pre-push` scans the range being pushed. A finding blocks the operation and prints the rule name, never the value.

`prepare-commit-msg`, `post-commit` and `post-rewrite` exist only so every hook name git may call resolves. Each one exits zero and does nothing. The agent session-recording callbacks that used to live in those three scripts, in `.codex/hooks.json` and in `.claude/settings.json`, have been removed, and the tracked `.entire/settings.json` records the recorder as disabled. Its redaction rules stay in place, because they protect a recording made some other way. [test/recording-hooks.test.ts](test/recording-hooks.test.ts) puts a stub recorder on `PATH`, commits and amends, and requires that nothing calls it while both credential gates still block.

## Reading the database code

[`src/db/schema.ts`](src/db/schema.ts) exports the ORM declarations used by application queries. Numbered [SQL migrations](migrations/) define the deployed database, including triggers and constraints that the ORM declarations do not express. [`scripts/db-migrate.ts`](scripts/db-migrate.ts) records each migration's hash and rejects a changed applied file. Make a new numbered migration for a database change and update the corresponding ORM declarations; do not edit an applied migration.

| Table family                                                           | Declarations                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Reference-fixture installation bookkeeping                             | [schema/fixtures.ts](src/db/schema/fixtures.ts)           |
| Actors, organizations, visitors, saved work and audit events           | [schema/identity.ts](src/db/schema/identity.ts)           |
| Intake, requests, revisions, clarification, model calls and model jobs | [schema/requests.ts](src/db/schema/requests.ts)           |
| Source observations, catalog entries and stewardship decisions         | [schema/inventory.ts](src/db/schema/inventory.ts)         |
| Asset and risk evidence, review tasks and RICE scores                  | [schema/review.ts](src/db/schema/review.ts)               |
| Human priority proposals and their review decisions                    | [schema/priority.ts](src/db/schema/priority.ts)           |
| Targeted input requests, responses and their resolution                | [schema/review-inputs.ts](src/db/schema/review-inputs.ts) |
| Handoffs, resolutions and external work synchronization                | [schema/delivery.ts](src/db/schema/delivery.ts)           |
| PostgreSQL enum bindings and column helpers                            | [schema/shared.ts](src/db/schema/shared.ts)               |

Domain vocabularies live in [domain/constants.ts](src/domain/constants.ts). Model calls and model jobs stay beside their draft and request references in the request schema; [models/worker.ts](src/models/worker.ts) coordinates their execution.

## Reviewer and priority workflow

Reviewer requests open on **Prepared assessment**, one prose page containing the confirmed need, proposed existing solutions, risk findings and priority estimates. Open a claim or estimate to work on it and ask for missing information in context. **History** is a quiet reference with a return to the working page; opening it preserves assessment drafts. Delivery is offered after review, while **Close this request without fulfillment** remains available during review. Administrator notes are in History. Older section links still resolve to their corresponding view, including the legacy review sections that now land on the assessment.

Claim edits stay as drafts until **Save progress** or **Complete first review** submits the changed judgments in one transaction. Successful empty asset and risk assessments still require explicit human affirmation. Completion keeps the fit/risk requirements, required task rating and named delivery owner/next task; a complete RICE score is no longer a prerequisite. See [review-submission.ts](src/workflow/review-submission.ts) for the transaction and [review-brief.tsx](src/ui/review-brief.tsx) for the editing surface.

Requesters can supply optional priority facts and known estimates. Those contributions are stored separately from request content and never enter model preparation inputs. Reviewers adopt, replace or reject individual estimates while retaining the original proposal and supplier, recorder and reviewer attribution. Complete reviewed factors produce a versioned `rice_scores` snapshot; missing factors and unresolved priority questions keep the request out of score rankings. Existing saved scores remain readable without invented proposal history.

An input request asks a specific contributor for a specific answer, or leaves allocation to the administrator when the person is unknown. My assignments shows addressed questions and replies awaiting the asking reviewer's judgment. A reply alone does not approve an estimate or clear a risk question: the corresponding current judgment resolves the question. Pending priority remains editable after first review while the request is unresolved. These operations use [priority.ts](src/workflow/priority.ts) and [review-inputs.ts](src/workflow/review-inputs.ts), not the requester clarification operation that revises content and starts reassessment.

An owner can read values saved in the retired priority editor under **Earlier saved priority form**. The disclosure uses the existing private `rice` saved-work scope, preserves the original units and named contributor when known, and keeps those reference values separate from reviewed estimates.

Changing **Demo view** keeps the same visitor actor. To exercise an exchange between different people, use separate browser profiles or private sessions and identify each session by its displayed name; another ordinary tab shares the same identity. The work lists are an in-app delivery mechanism, not email or chat notifications.

## Local ports

| Port | Purpose                                                        |
| ---- | -------------------------------------------------------------- |
| 3000 | Default web port in the README quickstart.                     |
| 4180 | Established local demo identified in IMPLEMENTATION_STATUS.md. |
| 4181 | Production app started by browser acceptance.                  |
| 4187 | Baseline app in the visual-comparison examples below.          |
| 4188 | Parity configuration fallback; the suite starts no server.     |
| 4192 | Candidate app in the visual-comparison examples below.         |
| 4195 | Web container published by the container check.                |

The visual-comparison ports are examples for separately started builds; set `E2E_BASE_URL` to the app you intend to compare. PostgreSQL uses a separate database port; the local Compose default is 5432.

An existing production server serves its built output; changing the checkout does not update that server. [next.config.ts](next.config.ts) uses `ONE_DOOR_BUILD_DIR`, defaulting to `.next`. Build into a separate ignored directory when a walkthrough is running, then use that same setting when starting the replacement server. Starting without the setting selects `.next` and can serve an older build. Pass the intended port explicitly, and use the intended database environment for both build and start; do not replace the running demo as part of a validation build.

## Database tests

Every `test:*` command other than browser/accessibility/container tests uses the caller's `DATABASE_URL`. These commands migrate, seed, and in several cases commit test records or restore fixture state. Use disposable, isolated databases—not the running application's database.

The CI `database` job runs database integrity, fixture operations, workflow, review, and HTTP-handler tests in that order. The other workflow suites use separate fresh databases. Follow that isolation locally. The model suite deliberately consumes its test quota; a reused database can fail its preconditions. Never change receipts or timestamps to get around that failure.

Tests use controlled provider doubles; ordinary CI makes no billable model calls. A live-model evaluation is separate and retains its successful and failed call receipts. Native [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) enforce the wire shape; the original Zod schemas still enforce field bounds, allowed references, and risk-finding consistency afterward.

The priority, requester-priority, review-submission, review-inputs and review-input-queue suites in [package.json](package.json) cover partial contributions, provenance, atomic rollback, replay, question resolution and discovery, and scoring after first review. They require the same isolated-database discipline. [Reviewer contribution browser checks](test/reviewer-contributions.acceptance.ts) exercise the corresponding requester, reviewer and contributor surfaces.

## Historical fixture upgrade check

`npm run test:fixture-upgrade` requires a fresh database whose name starts with `one_door_fixup`; `npm run test:upgrade-lifecycle` requires one starting with `one_door_upgrade_lifecycle`. Both use the original migration and seed code preserved in [upgrade baselines](test/fixtures/upgrade-baselines). Each test verifies the complete baseline file set before database work, installs the old fixture, and checks the current upgrade while preserving live evidence. Do not point either test at an application database.

The baselines do not require old Git objects or access to the personal repository. Their manifests record original source commits, Git blob identifiers, byte counts and SHA-256 hashes. Git identifiers refer to the original development history; [fixture verification](test/fixture-baseline.ts) checks the frozen bytes locally without fetching that history. Keep the baseline sources unchanged. An added, missing or edited file must fail verification rather than silently change what an upgrade test measures.

## Browser acceptance

Build first, then provide a fresh isolated database whose name begins `one_door_e2e`. Use a new database for each complete run: retained gate attempts can trigger the demo's access throttle on a rapid rerun. Do not disable the throttle or erase its records to make a test pass. For example, after creating that local test database:

```sh
node --env-file=.env --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
let url;
try {
  url = new URL(process.env.DATABASE_URL);
} catch {
  console.error("DATABASE_URL is invalid; check the private environment file.");
  process.exit(1);
}
url.pathname = "/one_door_e2e";
const result = spawnSync("npm", ["run", "test:browser"], {
  stdio: "inherit",
  env: { ...process.env, E2E_DATABASE_URL: url.href },
});
process.exit(result.status ?? 1);
JS
```

The test launcher migrates/seeds that database, starts the production app on loopback port 4181, and runs its worker with a controlled provider double. Local runs use installed Chrome; CI installs Chromium. Failures retain captures under `playwright-results/`.

`E2E_BASE_URL` instead targets an already-running app and does not install a test provider. Do not point a routine test run at the working demo: the browser journeys submit, rate, review, and change records, and a real worker can incur API charges.

## Automated accessibility

`npm run lint` includes the recommended `eslint-plugin-jsx-a11y` rules for JSX and TSX. Native USWDS control wrappers are mapped to their rendered elements. The configuration retains focusable scroll regions and explicit list semantics for lists without bullets.

`npm run test:a11y` runs the axe browser checks alone with the same build and isolated database setup as browser acceptance. The full `npm run test:browser` command includes them. The accessibility suite requires a local `one_door_e2e*` database and the browser server on port 4181; it opens forms and saves test drafts, so it must not target the working demo.

Scans cover WCAG A/AA rules through 2.2 and axe best practices, including authenticated detail pages, opened review controls, the completion form, errors, and a phone viewport. Violations fail the test. Each scan writes an `*-accessibility.json` report beneath the test's output directory, retaining rule IDs and element locations without element HTML. CI retains these as the `accessibility-reports` artifact even when the tests pass. `needsReview` contains findings axe could not decide; inspect those separately. A passing automated run does not replace keyboard, screen-reader, or user testing. The existing focus, touch-target, and zoom checks remain in place.

## Generated interaction checks

[Saved-work tests](test/saved-work.test.ts) compare the autosave controller with a small reference model over generated edit, save, offline, reopen and concurrent-save sequences. They run with `npm test`, require no database, and make no provider calls. Run them alone with:

```sh
npx vitest run test/saved-work.test.ts
```

The suite uses a fixed seed and 200 sequences of up to 40 commands. A failure reports a reduced command sequence with replay information. Keep a named regression for a confirmed bug, not just its random seed. The saved-work suite covers pending writes and invalid local backups; browser acceptance additionally exercises actual navigation, failed saves, explicit conflict recovery and review-draft restoration.

These checks follow the stateful-testing approach in the supplied frontend interaction guide. They do not certify every browser sequence. No nightly random-click service or scheduled mutation-testing job has been installed.

## Visual comparisons

Use two production builds—before and after the style change—with the same freshly seeded `one_door_parity` database and the same disposable demo credentials. Never use the working demo or its worker. [The fixture script](test/visual-fixture.ts) creates fixed requester and RICE states against the baseline app, stops its controlled worker, and writes private test sessions to the gitignored `.harness/visual-fixture.json`.

```sh
node --env-file=.env --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
let url;
try {
  url = new URL(process.env.DATABASE_URL);
} catch {
  console.error("DATABASE_URL is invalid; check the private environment file.");
  process.exit(1);
}
url.pathname = "/one_door_parity_stable";
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "test/visual-fixture.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url.href,
      PARITY_SETUP_URL: "http://127.0.0.1:4187",
      PARITY_ACCESS_CODE: process.env.DEMO_ACCESS_CODE,
    },
  },
);
process.exit(result.status ?? 1);
JS
```

The example assumes the prepared baseline is on port 4187 and uses the same private access code as `.env`. Credentials pass directly to the child process, without appearing in terminal output or command arguments. Generate references from that baseline, then compare the changed build on its separate port:

```sh
E2E_BASE_URL=http://127.0.0.1:4187 npx playwright test -c playwright.parity.config.ts --update-snapshots
```

```sh
E2E_BASE_URL=http://127.0.0.1:4192 npx playwright test -c playwright.parity.config.ts
```

Both projects capture complete screens: normal text and doubled browser-default text. The font size and `em` media-query behavior are asserted before and after every image; a temporary DevTools font override is insufficient because screenshot capture resets it. Only the animated native progress indicator is masked. Its visibility and accent color are checked separately.

Keep the fixture unchanged between builds. The references depend on Chrome, macOS font rendering, locale, dates and the test data; they are not cross-platform or timeless images. For a new date or changed fixture, prepare a new baseline deliberately. Review differences instead of regenerating references from a failing changed build. The normal application checks do not require these private local test sessions.

## Container check

Build the image, then point `CONTAINER_DATABASE_URL` at a fresh database named with the `one_door_container` prefix. The database must be reachable from Docker, rather than through the container's own loopback address.

```sh
docker build --tag one-door:local .
```

```sh
node --env-file=.env --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
let url;
try {
  url = new URL(process.env.DATABASE_URL);
} catch {
  console.error("DATABASE_URL is invalid; check the private environment file.");
  process.exit(1);
}
url.hostname = "host.docker.internal";
url.pathname = "/one_door_container";
const result = spawnSync("npm", ["run", "test:container"], {
  stdio: "inherit",
  env: { ...process.env, CONTAINER_DATABASE_URL: url.href },
});
process.exit(result.status ?? 1);
JS
```

The check uses port 4195 and creates named migration, web, and worker containers. It verifies migration, non-root runtime, database health, the demo gate, a database-backed view, and worker startup without model credentials. Containers are stopped and retained; the command prints their exact names. The test database and images remain until explicitly removed.

## Design and release

The [design index](design/README.md) lists questions, audits, verification and retained-state records, with their known dates and evidence limits. [Running-app questions](design/running-app-questions.md) describes the tasks guiding the screens. Design notes in the app explain selected requirements and decisions. The standalone HTML design artifact is not the deployed product, and older queue audits do not certify the current application.

Run every applicable check on the final tree. A published release also needs a passing CI run for its exact commit, review of the rendered screens, and an approved deployment configuration. Keep real credentials and generated local artifacts out of commits.
