# One Door implementation status

Reviewer workflow verified September 9, 2026. The app on port 4180 now serves the prepared Assessment and contribution workflow from the current local implementation. All existing business-table contents were preserved while four additive migrations brought the local demo to schema version 25. The hosted deployment and its approvals are separate; this local update does not publish a release. The [design index](design/README.md) identifies the dated evidence and later reviews.

One Door is a working, persistent application, not a mockup. The deployment boundaries recorded in the earlier handoff are retained below.

## Implemented locally

- A landing page opens freely switchable requester, reviewer and administrator workflows behind one shared demo code.
- Requesters use one saved workspace, up to two actual intake attempts, one optional strong-fit suggestion, optional priority contributions, and submission with a required task rating. Unknowns and failures have a manual OIT-review path.
- Reviewers read one prepared assessment containing the confirmed need, existing-solution proposals, risk evidence and priority estimates. Judgments are edited beside their evidence and submitted together. History is a quiet reference with a return, not a peer tab; delivery is offered after review. Early closure remains available without entering delivery tools. Unfinished decisions and queue return context survive navigation.
- Reviewers can search the governed catalogue and add an option for evaluation. The record identifies who added it and the catalogue version; addition is not acceptance and does not invent a model match score.
- Initial model preparation uses durable PostgreSQL jobs, immutable inputs and source snapshots, bounded retries and real Anthropic calls. RICE remains human-entered and deterministic.
- Priority proposals retain their suppliers, recorders and reviewing actors. Reviewers adopt, replace or reject individual values; only a complete reviewed assessment becomes a score eligible for ranking. Dedicated priority inputs and evidence stay outside model payloads.
- Targeted questions and attributed answers stay on the same request. My assignments exposes addressed questions and replies needing review; administrators can resolve allocation. A current human judgment, not receipt of any reply, resolves the question.
- Catalog stewardship includes source comparison, provenance, approval, publication, retirement and review-due work. Administrator monitoring and reports read the same request and delivery records.
- Demo controls restore the shared reference examples after fresh confirmation while retaining visitor-created work, ratings, costs and history. A web reset records the initiating actor.
- Corrected examples now have coherent review scores, current assessment references and linked conversation answers. An append-only upgrade has been applied to the local demo without rewriting existing evidence.
- Intake distinguishes its first pass from refinement and shows changed summary text inline. Priority uses focused factor editors. First review may complete while priority is pending; fit/risk requirements, the task rating and a named delivery lead with a next task still apply. Priority work can continue afterward while the request is unresolved.
- Saved-work state is tested with generated edit/save/reopen sequences. Unsent edits cannot silently replace a newer server draft after reload. Contribution and assessment integration checks exercise attribution, conflicting submissions, replay and transaction rollback.
- Component and feature styles live in CSS modules. Global styles are limited to shared foundations and controls; the retired requester asset-menu component was removed without removing its backend history or API protections.
- Reviewer tables retain their content and position through sort/filter updates, with visible column order and a sort summary.
- Tables fit standard desktop widths without custom scrolling controls. Queue and catalog pagination begins above 100 matches, after full-dataset filtering and sorting.
- Administrator notes persist in History, where administrators can add notes and reviewers can read them.
- Four additional reference requests demonstrate all six lifecycle phases with generation-safe reset behavior.

The running app is [http://127.0.0.1:4180/](http://127.0.0.1:4180/) and uses `one_door_live_mvp` on localhost:5432. It serves the standard `.next` build; pass `--hostname 127.0.0.1 --port 4180` when starting it. Verify the current `DEMO_ACCESS_CODE` from `.env.local` when sharing the local URL; do not assume an earlier code still works. The reviewer implementation is committed locally on `reviewer-prepared-assessment-20260908`; it has not been pushed or merged into upstream main while the CI/publishing hold remains. The runtime credential remains in the Keychain service `anthropic-api`. Neither credentials nor browser-session tokens belong in the repository.

[Prepared-assessment verification](design/reviewer-brief-rules-record.md) records the current reviewer screens, actual question/reply journeys, private earlier-draft access, and visual comparisons. Human design acceptance is still pending.

[Desktop table review](design/desktop-table-audit.md) records the table composition and interaction checks. [Reviewer UI verification](design/reviewer-ui-verification.md) records the preceding live-data upgrade and its recovery copies.

[Focus and note-layout review](design/focus-and-notes-review.md) records the app-wide neutral focus treatment and the former administrator note column beside the request. Notes now live in History. Active fields use an inset stroke instead of a blue halo; keyboard navigation uses contrasting neutral outlines. Draft persistence and posted-note behavior are unchanged.

## Evidence and boundaries

[Workflows-four verification](design/workflows-four-verification.md) records the live data comparison, model evaluation, local checks and retained backup. [The design audit](design/workflows-four-audit.md) records the screen review and its remaining limits. [The original queue audit](design/request-queue-audit.md) and [the pass-two audit](design/pass-two-audit.md) are historical artifacts, not certifications of these screens.

[The understandability review](design/understandability-audit.md) covers the subsequent intake, reviewer and RICE changes.

- [The three-case timing comparison](design/intake-timing-20260906.json) retains identical-input observations for intake-v5 and intake-v6.
- Intake requests medium effort; asset and risk preparation retain high effort.
- The shorter observed waits do not certify model accuracy. Reviewer-facing explanations still need review.

[The CSS comparison](design/css-module-parity.md) records the final 68-state comparison, including genuine doubled-text captures. Those captures supersede earlier screenshots labeled as enlarged text that used a temporary DevTools override.

The bounded model evaluation used seven fictional needs and retained all successful and failed call receipts. It is not general accuracy certification or user research. Inventory, policies and external systems remain fictional; delivery actions update real local simulated records, not Colorado tenants.

## Hosted-handoff notes retained from the preceding review

These items preserve the earlier handoff's scope and evidence limits; they are not a current inventory of cloud resources or deployment approvals.

- Maz/design review of the revised rendered journeys is pending. Agent checks do not replace that review.
- OIT research participants and sessions remain to be arranged; seeded or developer ratings do not establish customer satisfaction.
- Hosting, public HTTPS, an automated off-host backup schedule and a final hosted walkthrough require a reviewed host/cost decision. Container packaging and local backup restoration are exercised; no AWS or Linode resource has been provisioned.
- The broader SOO build-team evidence and comparison with a traditional-delivery baseline remain separate work; a local guardrail failure is not a production change failure.

GitHub CI and GitHub issues were explicitly waived from the recorded handoff phase by Maz. That session-specific waiver does not waive validation for later changes. Local checks remain required. Real agency identity, real tenant writes, procurement execution and a separate mobile design remain outside the agreed demo scope.
