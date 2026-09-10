# Workflows four: verification and handoff

September 5, 2026 (local date; receipt timestamps are UTC). The deliverable is the working PostgreSQL-backed app, not a mockup. Local verification is complete. Hosting is outside this pass.

## Implemented

- Reviewer work is one request with URL-selected Request, Matches, Risk, Priority, Complete review, Delivery and History sections. Unfinished decisions survive navigation, Back and reload. The overview suggests the next task; an active review section keeps its own actions prominent.
- Catalog opens on entries needing attention, with separate overdue and source-disagreement filters. Source evidence remains beside the canonical values. Wide tables provide visible directional controls and retain row/column context at enlarged text sizes.
- Administrator → Demo controls restores shared examples after fresh confirmation. Visitor-created requests, unfinished work, ratings, costs and earlier evidence remain. Web-initiated restoration records the authenticated actor; CLI restoration remains a system operation.
- Fixture corrections provide scores and pinned evidence for completed reviews, current corpus hashes for ordinary examples, and actual question/answer links. Legacy closing statements are shown as intake notes, not unanswered questions. A deliberately stale example and deliberate failure cases remain.

## Live data upgrade

A PostgreSQL backup was restored into an isolated rehearsal database before the live upgrade. In both rehearsal and `one_door_live_mvp`, the upgrade added **292 reference-evidence/reply rows**. A full-row comparison checked all **1,947 pre-existing rows**: only the intended fixture score/evidence pointers, their row versions, and the reference manifest changed (16 rows). Every other prior field remained unchanged. Repeating the upgrade added nothing.

The backup is retained at `/tmp/one-door-before-workflows4.KsSkjS/live.dump` inside `one-door-postgres`. It is a local checkpoint, not an off-host backup. Human-revised requests remain unscored when reassessment is required; the upgrade does not interpret a cleared score as permission to restore an old template score.

## Bounded live model evaluation

Seven fictional needs exercised strong service and asset fits, partial coverage, no match, ambiguous requirements, refinement, and a security-sensitive proposal containing an untrusted instruction. **17 actual provider attempts** used the normal application ledger and caps; the recorded cost is **$1.261670** at the application's configured rates. No request submission or satisfaction rating was created by this evaluation.

Two baseline attempts failed identifier validation and remain in the ledger. Later calls constrain identifier fields using the supplied corpus, with the original local validation still enforced. Prompt revisions distinguish unmet capabilities from unused features and favor a whole service over an underlying component when appropriate. The provider supports string enums in its structured-output schema; this is not a claim that every generated assertion is true. [Anthropic structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations).

- [Predeclared cases and baseline outputs](model-quality-evaluation-20260905.json)
- [Follow-up outputs and limitations](model-quality-followup-20260905.json)
- [Exact input and corpus snapshots, including refinement answers](model-quality-inputs-20260905.json)
- [Supplementary asset-only case and display result](model-quality-asset-only-20260905.json)
- [All provider receipts, including failures](model-quality-receipts-20260905.json)

The final v5 service and asset suggestions were also checked in the actual requester screen; each displayed exactly one option. Screenshots are `07-live-service-suggestion.png` and `07-live-asset-suggestion.png` in `screenshots/workflows-four/`.

These are mixed-version development observations, not a single-version accuracy benchmark. The baseline notice suggestion would have been withheld because it had gaps; the v4 release suggestion would have been withheld because its chosen asset had a dependency. Those are source-based render-gate conclusions, not browser observations. The corrected v5 release and supplementary asset-only case are display-verified. Marginal reviewer candidates and wording still require human judgment. OIT user research has not occurred, and this evaluation says nothing about measured user satisfaction.

## Verification scope

The final code passed 65 unit tests, all 16 browser journeys, the database/workflow/model/inventory command suite, and the historical fixture-upgrade check. Strict repo-harness verification passed all seven checks; every supported deliberate-violation test was caught and restored. [Guardrail record](workflows-four-harness.json).

The upgrade regression also verifies that a human-revised request stays unscored and that an explicit reset restores the correct assessment reference while retaining the previous run's evidence. The final container package passed migration, non-root web, access gate, database-backed view, and worker-start checks without making provider calls.

Local checks cover seed invariants, unit tests, database integrity, workflow/review/API transitions, model leases and caps, current-result reuse, inventory governance, reset/upgrade retention, browser journeys and the production container. Ordinary tests use controlled providers on isolated databases. The live evaluation is separate. GitHub CI and issues were not investigated, per Maz's instruction for this phase.

[Design review](workflows-four-audit.md) records the screen method and 147-rule assessment. **Human design approval remains pending Maz/design.** Source comparison does not automatically highlight differing cells; assignment lists include demo people and visitor sessions, with the current visitor identified as Me. Seeded risk prose remains illustrative and sometimes templated.

## Not done in this pass

No host, public HTTPS, off-host backup schedule, real identity provider, or real ServiceNow/Azure DevOps connection was provisioned. No claim of general model accuracy, agency approval, OIT research validation, or comparative engineering performance is made.
