# Requester intake verification and retained test state

September 5, 2026.

## Working result

The integrated app runs on http://127.0.0.1:4180 with the existing `one_door_live_mvp` database and existing local demo/session configuration. No live database reset or schema migration was needed for this change. The requester has one saved workspace, at most two actual intake attempts including retries, one optional strong-fit suggestion, and OIT-routed submission. Reviewers receive candidate evidence and the intake dialogue. Task ratings and human-only RICE are unchanged.

The private backup repository is https://github.com/rswerve/one-door. Initial WIP snapshots were pushed as `wip-current-20260905`, `wip-intake-ui-20260905`, and `wip-intake-backend-20260905`. Credentials, browser-session state, local databases, dependencies, and generated builds are not source backups.

## Checks on the integrated working copy

- Format, lint, typecheck, seed validation, 59 unit tests, production build, secret scan, and dependency audit passed.
- Strict repo-harness verification passed all seven checks, with zero weak, unavailable, failing, or unrun checks. Supported trip tests caught their deliberate violations.
- Database, fixture operations, workflow/safety, review, API, intake, intake-workspace, model, catalog, reset, read-model, review-corrections, delivery-lineage, cache-currency, and requester-fit commands passed on separate test databases or the declared database/fixture/workflow/review/API chain.
- All 13 browser journeys passed against the main working copy's production build. Coverage includes persistence and return, one-page refinement, manual field validation, suggestion verdicts, concurrency recovery, manual fallback, reviewer handoff, human RICE, delivery failure/retry/fulfillment, reports, and inventory stewardship.
- The `one-door:intake-three` container image passed migration, non-root web, gate, database read, and worker-start checks without a model key in the container.
- The live Anthropic check used the normal ledger, not a fresh quota database. Draft `967132ea-404c-4aa2-9ad6-c6dc2e4f15bf` succeeded on attempt two after the first response failed identifier validation. Both receipts remain. The result had concise requirements, three business questions, and no requester suggestion. No further intake attempt was made on that draft.
- Claude independently confirmed the previously missing service evidence, exact requester/reviewer dialogue, dependencies, explicit failure state, and stable answered-question layout. Human design review is still pending; see `requester-intake-audit.md`.

Maz explicitly waived GitHub CI for this phase on September 5 and asked us to continue the app without investigating GitHub issues. Local checks remain required. No remote CI success is claimed; the waiver is session-specific, not a change to the repository's standing rule.

## Follow-up application verification

After the CI waiver, an input trace found that post-submission asset and risk calls omitted saved intake answers. Both the draft and submitted-request paths now include answered intake exchanges. Answerless inputs keep their prior hashes; answer-bearing assessments become stale when their saved input lacked those facts. Closed-review evidence remains pinned.

The real QA request [OD-2001](http://127.0.0.1:4180/review/b35f4d2f-192f-45f4-a43f-7edd321381f2), titled “QA — Offline landslide intake handoff”, was submitted with all three late answers after its two intake attempts were used. Both asset and risk jobs succeeded on their first attempts, and both input snapshots contain every question and answer verbatim. The QA survey value of 3 is a test input, not participant research evidence. The live QA request and its cost ledger are retained, not included in disposable-database cleanup.

My requests now uses the same active workspace identity as the request page. A saved title takes precedence over the prepared title without changing canonical content. The matching saved-work timestamp is displayed. A visitor-scoped rating from the older submission screen initializes the new screen when no newer saved work exists. Integration and browser tests cover both behaviors and visitor isolation.

All local check commands passed again on the integrated copy, including the full database suite, 13 browser journeys, and the updated `one-door:intake-followup` package. CI was not monitored or treated as a completion gate, per Maz's instruction.

## Limits kept explicit

The two-attempt limit includes an automatic retry, so one click can consume both attempts. Answers and manual edits can still be sent to OIT. Risk and any necessary asset refresh occur after submission for the reviewer.

An edited legacy draft clears its old adopted-evaluation anchor. Earlier rejection reasons remain available to the reviewer, but are not automatically fed into a new asset refresh as current feedback. Current-flow rejection feedback still affects the refresh.

Newer saved work stays authoritative, including a blank rating; an older rating does not overwrite it. A blank draft title uses a recognizable list label without changing the blank editable value. Draft-list identity reads are per draft; batching is deferred until large personal draft lists make the lookup slow.

This pass does not deploy to AWS or another host, connect real ServiceNow/Azure DevOps systems, or establish general model quality from one live case. Inventory and policy data remain fictional.

## Retained state — removal requires Maz's approval

Keep the running app, real worker, `one_door_live_mvp`, project source, environment files, and committed evidence. Do not remove them during test cleanup.

Disposable local working copies (move to Trash if approved):

- `/Users/atighi/dev/co_ai-intake-ui.CSfEDj`
- `/Users/atighi/dev/co_ai-intake-backend.sfyGZQ`

Browser-session state, not committed:

- `/tmp/one-door-intake3-live-browser.json` (mode 0600; the live-check visitor session)
- `/Users/atighi/dev/co_ai-intake-backend.sfyGZQ/design/screenshots/intake-three-review/state.json`
- `/Users/atighi/dev/co_ai-intake-backend.sfyGZQ/design/screenshots/intake-three-review/state-final.json`

The backend evidence folder also contains temporary driver scripts. Selected screenshots were copied into the main repository. The temporary server on 4197 was stopped; the main browser suite stopped its 4181 server.

Stopped packaging-test containers:

- `one-door-check-c349b7eaac-migrate`
- `one-door-check-c349b7eaac-web`
- `one-door-check-c349b7eaac-worker`
- `one-door-check-248a75e961-migrate`
- `one-door-check-248a75e961-web`
- `one-door-check-248a75e961-worker`

Local test images: `one-door:intake-three` and `one-door:intake-followup`. No image or global Docker cache pruning is authorized by this record.

The following 147 test databases are on the local `one-door-postgres` container. They contain fixture/test state, not the live app's requests. Dropping them discards their run-specific rows; fixture data can be regenerated, but exact failed-run state cannot.

<details>
<summary>Retained test-database names from this verification</summary>

```text
one_door_container_intake3
one_door_container_intake3_followup
one_door_e2e_intake3_design
one_door_e2e_intake3_final
one_door_e2e_intake3_main
one_door_intake3_cachecur
one_door_intake3_catalogx
one_door_intake3_chain
one_door_intake3_deliveryx
one_door_intake3_finish_cache_currency
one_door_intake3_finish_catalog
one_door_intake3_finish_chain
one_door_intake3_finish_delivery_lineage
one_door_intake3_finish_intake
one_door_intake3_finish_intake_workspace
one_door_intake3_finish_model
one_door_intake3_finish_read_model
one_door_intake3_finish_requester_fit
one_door_intake3_finish_reset
one_door_intake3_finish_review_corrections
one_door_intake3_i7
one_door_intake3_i8
one_door_intake3_i9
one_door_intake3_intake
one_door_intake3_intake2
one_door_intake3_late_input
one_door_intake3_m106_api
one_door_intake3_m106_cache_currency
one_door_intake3_m106_catalog
one_door_intake3_m106_database
one_door_intake3_m106_delivery_lineage
one_door_intake3_m106_fixture_operations
one_door_intake3_m106_intake
one_door_intake3_m106_intake_workspace
one_door_intake3_m106_model
one_door_intake3_m106_read_model
one_door_intake3_m106_requester_fit
one_door_intake3_m106_reset_interactions
one_door_intake3_m106_review
one_door_intake3_m106_review_corrections
one_door_intake3_m106_workflow
one_door_intake3_m106_workflow_chain
one_door_intake3_m107_api2
one_door_intake3_m107_cache_currency
one_door_intake3_m107_catalog
one_door_intake3_m107_database
one_door_intake3_m107_delivery_lineage
one_door_intake3_m107_fixture_operations
one_door_intake3_m107_intake
one_door_intake3_m107_intake_workspace
one_door_intake3_m107_model
one_door_intake3_m107_read_model
one_door_intake3_m107_requester_fit
one_door_intake3_m107_reset
one_door_intake3_m107_reset_interactions
one_door_intake3_m107_review
one_door_intake3_m107_review_corrections
one_door_intake3_m107_wfchain
one_door_intake3_m107_workflow
one_door_intake3_m82_api
one_door_intake3_m82_cache_currency
one_door_intake3_m82_catalog
one_door_intake3_m82_container
one_door_intake3_m82_database
one_door_intake3_m82_delivery_lineage
one_door_intake3_m82_fixture_operations
one_door_intake3_m82_intake
one_door_intake3_m82_intake_workspace
one_door_intake3_m82_model
one_door_intake3_m82_read_model
one_door_intake3_m82_requester_fit
one_door_intake3_m82_reset_interactions
one_door_intake3_m82_review
one_door_intake3_m82_review_corrections
one_door_intake3_m82_workflow
one_door_intake3_m82_workflow_safety
one_door_intake3_m92_api
one_door_intake3_m92_cache_currency
one_door_intake3_m92_catalog
one_door_intake3_m92_database
one_door_intake3_m92_delivery_lineage
one_door_intake3_m92_fixture_operations
one_door_intake3_m92_intake
one_door_intake3_m92_intake_workspace
one_door_intake3_m92_model
one_door_intake3_m92_read_model
one_door_intake3_m92_requester_fit
one_door_intake3_m92_reset_interactions
one_door_intake3_m92_review
one_door_intake3_m92_review_corrections
one_door_intake3_m92_workflow
one_door_intake3_m92_workflow_chain
one_door_intake3_m95_cache_currency
one_door_intake3_m95_intake
one_door_intake3_m95_read_model
one_door_intake3_main_cache_currency
one_door_intake3_main_catalog
one_door_intake3_main_chain
one_door_intake3_main_delivery_lineage
one_door_intake3_main_intake
one_door_intake3_main_intake_workspace
one_door_intake3_main_model
one_door_intake3_main_read_model
one_door_intake3_main_requester_fit
one_door_intake3_main_reset
one_door_intake3_main_review_corrections
one_door_intake3_model
one_door_intake3_model2
one_door_intake3_model3
one_door_intake3_model4
one_door_intake3_model5
one_door_intake3_readmodex
one_door_intake3_requeste
one_door_intake3_resetx
one_door_intake3_reviewcox
one_door_intake3_root01
one_door_intake3_root_cache_currency
one_door_intake3_root_catalog
one_door_intake3_root_chain
one_door_intake3_root_delivery_lineage
one_door_intake3_root_intake
one_door_intake3_root_model
one_door_intake3_root_read_model
one_door_intake3_root_requester_fit
one_door_intake3_root_reset
one_door_intake3_root_review_corrections
one_door_intake3_saved_title
one_door_intake3_ws
one_door_intake3_ws10
one_door_intake3_ws11
one_door_intake3_ws12
one_door_intake3_ws13
one_door_intake3_ws14
one_door_intake3_ws15
one_door_intake3_ws16
one_door_intake3_ws17
one_door_intake3_ws18
one_door_intake3_ws19
one_door_intake3_ws2
one_door_intake3_ws20
one_door_intake3_ws3
one_door_intake3_ws4
one_door_intake3_ws5
one_door_intake3_ws6
one_door_intake3_ws7
one_door_intake3_ws8
one_door_intake3_ws9
```

</details>

Retention exception: Claude recreated `one_door_intake3_ws10` after a failed test setup. That earlier test-only run's rows were discarded and cannot be recovered. The live database was not involved. Subsequent failed runs were retained in separate databases.
