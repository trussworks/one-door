# Reviewer UI pass: verification and handoff

September 6, 2026. The updated production build is running locally at
http://127.0.0.1:4180/ with the existing demo gate and real model worker.

## Changes

- Sortable headings are plain text with a direction arrow. The queue opens by longest wait; Wait and Submitted are explicit columns, and a summary outside the scroller keeps the selected order visible with enlarged text.
- Query updates retain the table and its rows. Failed reads retain the previous results and offer retry; empty feedback appears above the fixed-height pane. Tests preserve document and both table scroll offsets during sorting.
- Request-section selection keeps focus on its navigation link without moving the page or outlining the entire section. Underline spacing removes the apparent punctuation after History and Delivery.
- RICE explains that the counting unit is open text. Reach accepts whole-number digits without number spinners. Impact guidance follows the chosen unit; people still supply all RICE judgments.
- Administrators can add attributed notes from a request's Request section. Drafts autosave privately; posting makes the note visible on reviewer/admin views. Notes append without changing the request's assessment version, and retrying a note ID cannot create a duplicate.
- Four distinct reference requests add received, waiting, delivery and resolved examples without repurposing the existing narratives. Approved examples have actionable intended handoffs. Reference lifecycle state returns after a reset while human actions remain in history.

## Evidence

The final checks passed: 93 unit tests, all 32 browser journeys, all 19
database/workflow/API/model/fixture command suites, and the production-container
check. [Strict repo-harness](reviewer-ui-harness.json) passed seven checks, with
all supported deliberate-violation probes caught and restored. Model tests use
injected providers, not billable calls. GitHub CI and issues were not reviewed,
as instructed.

The reviewer interaction suite shares a normal authenticated session across
fresh browser contexts. Authentication/ownership/throttling tests remain
separate; the app's sign-in limit was not changed to accommodate test traffic.

[The design record](reviewer-ui-audit.md) covers 147 rules and 51 captured
states: 17 screens/states at 1440px, 1280px and genuinely doubled browser-default
text. Claude independently reviewed the rendered flows and confirmed the final
empty-state, sort-summary and underline fixes. Human design approval and actual
screen-reader speech testing remain pending.

## Live data and recovery

The upgrade was rehearsed on a restored copy, then applied to the live
database. The comparison accounted for all 2,392 pre-existing rows without an
unexpected change. Intentional differences were the empty delivery-owner fields
on completed reference examples, row-version increments and the fixture
manifest. Existing request content, history, receipts and saved work survived.
The request count increased from 31 to 35; all 25 saved-work records remained.

The live browser check confirmed all six phases and eight named delivery
owners. Its disposable visitor had no requests, drafts, model calls, notes or
saved work and was removed after verification; the live totals remained intact.

Recovery copies remain in `one-door-postgres` at
`/tmp/one-door-before-reviewer.P7TPqg/live.dump` and `before-cutover.dump`, and
under the repository's gitignored `.harness/` as
`before-reviewer-P7TPqg.dump` and `before-reviewer-cutover-P7TPqg.dump`.
The rehearsal database `one_door_review_rehearsal_p7tpqg` is retained. These are
local recovery copies, not an off-host backup service.

Seventy-four positively identified test databases, six stopped test containers,
the temporary UI-review scripts, and about 440 MB of preview build output were
removed. Fixture/test state can be regenerated; tracked artifacts remain in Git.
Baseline worktrees, the existing visual fixture, shared browser caches and other
resources of uncertain ownership were left untouched.

No hosting resource or real agency integration was added. Notes identify demo
visitor sessions; freely switching demo views is not employee authorization.
