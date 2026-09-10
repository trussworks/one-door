# Code quality and verification

September 6, 2026. The working local app remains on port 4180 with `one_door_live_mvp`; no hosting resource was provisioned.

## Changes

- Styles are organized into twenty component/feature CSS modules. Global styles contain shared foundations and controls. [The visual comparison](css-module-parity.md) records 68 complete screen states and the one accepted endpoint-pixel difference.
- The saved-work controller is separate from its React hook. Generated command sequences and named regressions cover offline saves, reopening, concurrent writes, malformed browser backups and late responses. RICE preserves its next step before waiting for persistence.
- Narration and outdated work notes were removed from comments. Non-obvious constraints around concurrency, spend, lineage and recovery remain. The orphaned requester asset-menu UI and its helper-only tests were removed; backend APIs and history protection remain.
- [The intake comparison](intake-timing-20260906.json) retains the bounded real-model observations. The three updated calls took 24.948, 25.362 and 12.014 seconds, versus 43.848, 43.852 and 14.101 seconds in the baseline. Matching outcomes were retained; individual model explanations still require review.

## Verification

The final source passed 91 unit tests, all 19 browser journeys, all sixteen database/workflow/API/model/fixture command suites (including the historical fixture-upgrade check), and the production-container check. [Strict repo-harness verification](code-quality-harness.json) passed all seven checks; every supported deliberate-violation probe was caught and restored. Browser and database tests used isolated datasets and controlled providers. Real-model observations are separate.

Claude implemented the CSS migration in assigned areas and independently reviewed the saved-work controller, hook and API contract. Codex reviewed and integrated those changes, completed the shell/reviewer migration, corrected the visual verification, and retained ownership of user-facing wording. The development-guide additions were checked against source and the executed commands.

## Recovery and limits

The live migration preserved all 2,279 pre-existing rows across 42 non-ledger tables in the before/after comparison. Its retained backups are `/tmp/one-door-before-understandability.7FSs7S/live.dump` and `before-update.dump` inside `one-door-postgres`; these are local recovery copies, not an off-host backup service. The live app still contains 29 requests and 20 WIP records.

On a slow link, reopening while an earlier save completes can produce a conflict against that same user's earlier save. The entries remain available, and the explicit replacement control resolves the conflict. The app does not silently adopt a newer base version.

Obsolete test databases, stopped test containers and superseded golden images were removed under Maz's authorization. Current visual fixtures and migration-recovery resources were retained. Fixture data can be regenerated; removed tracked artifacts remain recoverable from Git history.

GitHub CI and issues were not investigated, as requested. Human design approval, screen-reader speech testing, OIT research, hosting, an automated off-host backup schedule and real tenant integrations are not claimed by this pass.
