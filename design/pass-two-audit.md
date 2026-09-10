# Pass two: screen-design review

Navigation annotation: September 7, 2026. Original document date not recorded. Historical pass. The requester flow was replaced by [the requester-intake flow](requester-intake-questions.md); [the desktop-table audit](desktop-table-audit.md) records later table changes.

Scope: the landing, requester confirmation/review-and-submit, model waiting, reviewer/admin queues, and Reports filter layout. This does not certify every existing catalog/editor/history screen or the overall MVP. Maz explicitly requested desktop design; phone layouts and a separate dark theme are not certified here.

Evidence: [reader questions](pass-two-questions.md); before captures 01–04, stripped captures 05–08, and rebuilt captures 09 onward in [screenshots/pass-two](screenshots/pass-two). Browser acceptance exercises the real app with an isolated database and controlled model provider; the multi-asset stress rendering uses explicitly injected browser fixtures, not fabricated server outcomes. Styling/semantic claims below combine rendered inspection with the corresponding source and browser assertions; they are not a screen-reader user study or a performance benchmark.

The human design gate is **pending Maz/design review**. Claude's visual review informs the changes but cannot satisfy that gate. This record is scoped to this pass, not a claim that the existing seed-data issues or deployment work are resolved.

Two constraints affect the rule interpretation: supplied provider APIs give no meaningful percent-complete value, so honest indeterminate progress is used; standard USWDS component separators remain where Maz requested its conventions. No fake progress percentage or custom replacement control was added merely to satisfy a checklist.

| #   | Rule                                        | Result         | Evidence or reason                                                                                                               |
| --- | ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task clarity                                | Pass           | Landing names three jobs; review ends in a named Send section.                                                                   |
| 2   | Clear primary action                        | Pass           | Submission is the only primary action after removing per-asset save buttons.                                                     |
| 3   | Natural task flow                           | Pass           | Summary, possible solutions, then sending follow the requester's decisions.                                                      |
| 4   | One primary answer per question             | Pass           | Identical original/problem text appears once on the confirmation step.                                                           |
| 5   | Essential controls only                     | Pass           | No-match has no one-option radio; undecided needs no extra save action.                                                          |
| 6   | Aesthetic and minimalist design             | Pass           | Empty summary placeholders and idle per-card status lines are removed.                                                           |
| 7   | Optimize comprehension, not click count     | Pass           | Summary confirmation and service routing remain distinct tasks with Back.                                                        |
| 8   | Consistency and standards                   | Pass           | Existing USWDS typography, buttons, forms, and side navigation remain in use.                                                    |
| 9   | Internal consistency                        | Pass           | The same filter grid and input height serve Reports and both queues.                                                             |
| 10  | Native semantics first                      | Pass           | Links navigate; native selects, inputs, progress, buttons, and headings retain semantics.                                        |
| 11  | Safe defaults                               | Pass           | Fit begins undecided and cannot imply acceptance; submission still requires a rating.                                            |
| 12  | Match between system and real world         | Pass           | Fit labels describe usefulness and uncertainty rather than decision enum values.                                                 |
| 13  | Recognition rather than recall              | Pass           | Summary, gaps, selected feedback, and the final action stay visible.                                                             |
| 14  | Clear visual hierarchy                      | Pass           | H1 identifies the page; H2 divides summary, recommendations, and sending.                                                        |
| 15  | Use multiple hierarchy cues                 | Pass           | Heading size, position, and a single primary action establish order.                                                             |
| 16  | De-emphasize secondary content              | Pass           | Design notes and fit strength are subordinate to request content and submission.                                                 |
| 17  | Contrast follows importance                 | Pass           | Blue identifies actions; backgrounds support grouping without heavy outlines.                                                    |
| 18  | Action hierarchy matches consequence        | Pass           | Submit dominates; Back and Save and exit remain recognizable secondary actions.                                                  |
| 19  | Destructive-action hierarchy                | Not applicable | None of the revised task screens deletes records or resets fixtures.                                                             |
| 20  | Stable font weight across states            | Pass           | The changed styles do not alter font weight on hover or selection.                                                               |
| 21  | Displayed-data labels earn their place      | Pass           | The summary uses one For label and grouped facts; empty field labels disappear.                                                  |
| 22  | Gestalt proximity                           | Pass           | Each fit control stays in its candidate; rating stays in the Send section.                                                       |
| 23  | No horizontal rules                         | Pass           | Revised sections use spacing; standard USWDS navigation/table separators are retained.                                           |
| 24  | Whitespace before other dividers            | Pass           | Summary groups use whitespace; a candidate tint marks a separate proposed solution.                                              |
| 25  | Content-driven width                        | Pass           | Request review is bounded to 48rem; filters no longer stretch the last control across a row.                                     |
| 26  | Spacing and sizing scale                    | Pass           | New spacing uses existing quarter-, half-, one-, and two-rem increments.                                                         |
| 27  | Design tokens                               | Pass           | USWDS colors and installed typography are retained; layout roles are in app.css.                                                 |
| 28  | Visual-role consistency                     | Pass           | All filter inputs use a 40px height and the same three-column grid.                                                              |
| 29  | Limited visual roles                        | Pass           | New type roles are landing heading, section heading, body, and supporting label.                                                 |
| 30  | Bounded fluid sizing                        | Pass           | Widths are max-bounded; the grid changes to one column at enlarged text sizes.                                                   |
| 31  | Scale component properties independently    | Pass           | Heading size, card padding, and control dimensions are set independently.                                                        |
| 32  | Intentional visual decisions                | Pass           | Cyan identifies orientation/strong fit; the queue grid expresses equal filter roles.                                             |
| 33  | Readable body-text size                     | Pass           | Browser measurements at 1440 and 1280 report a 16px body.                                                                        |
| 34  | Touch input text size                       | Not applicable | This pass follows Maz's desktop scope; it does not certify a touch layout.                                                       |
| 35  | Readable measure                            | Pass           | The requester flow has a bounded measure; long facts wrap without clipping.                                                      |
| 36  | Minimum line height                         | Pass           | Body and fact lists use 1.5 line height; landing headings use 1.15/1.3.                                                          |
| 37  | Responsive line height                      | Pass           | Long prose keeps 1.5; headings use tighter explicit line heights.                                                                |
| 38  | Tracking follows size and case              | Not applicable | No tiny uppercase labels or small-caps type were introduced.                                                                     |
| 39  | Limit emphasized passages                   | Pass           | Bold is restricted to headings, fit bands, and short status labels.                                                              |
| 40  | Limited type palette                        | Pass           | The installed USWDS type palette is unchanged; no font dependency was added.                                                     |
| 41  | Readable font weights                       | Pass           | Body text uses regular weight; headings and fit bands use readable stronger weights.                                             |
| 42  | Left-align running text                     | Pass           | Landing, summary, evidence, and feedback text are left-aligned.                                                                  |
| 43  | Typographic baseline alignment              | Pass           | Report controls share an exact top coordinate; peer controls align within each row.                                              |
| 44  | Tabular figures                             | Pass           | Queue scores and metric cells retain tabular-figure styling.                                                                     |
| 45  | Purposeful typeface selection               | Pass           | The app uses the installed USWDS type system chosen for the government-service interface.                                        |
| 46  | Avoid absolute black and white              | Pass           | The large app surface is off-white; primary text is #1b1b1b, not absolute black.                                                 |
| 47  | Coherent neutral palette                    | Pass           | Neutral supporting surfaces remain low-saturation; cyan is an intentional accent.                                                |
| 48  | Luminance separates palette roles           | Pass           | Navy headings, blue controls, pale accents, and off-white surfaces differ in lightness.                                          |
| 49  | Defined colour ramps                        | Pass           | Existing USWDS navy/blue/pale-blue roles are reused rather than new random shades.                                               |
| 50  | Single primary accent                       | Pass           | Interactive emphasis remains USWDS blue.                                                                                         |
| 51  | Do not rely on colour alone                 | Pass           | Fit strength is written as text; selected controls retain native state.                                                          |
| 52  | Contrast hierarchy                          | Pass           | Dark text and blue actions have greater emphasis than pale supporting surfaces.                                                  |
| 53  | Text contrast                               | Pass           | Navy/blue/dark text retain the previously measured AA palette on light surfaces.                                                 |
| 54  | Purposeful boundaries                       | Pass           | Candidate tint groups one proposal; input borders identify editable controls.                                                    |
| 55  | One visual separator per boundary           | Pass           | New summary groups have spacing alone; new candidate groups have one tinted boundary.                                            |
| 56  | Use borders sparingly                       | Pass           | No new bordered section boxes surround the summary or final Send section.                                                        |
| 57  | Border contrast                             | Pass           | Native form borders remain visible against their light fill and surrounding surface.                                             |
| 58  | No stacked hard separators                  | Pass           | New sections do not stack a rule, border, and background transition.                                                             |
| 59  | Consistent elevation system                 | Not applicable | The revised screens introduce no elevated surfaces or shadows.                                                                   |
| 60  | Consistent light source                     | Not applicable | No simulated lighting or raised/inset decoration is used.                                                                        |
| 61  | Shadow blur-to-offset ratio                 | Not applicable | No new shadows are used.                                                                                                         |
| 62  | Depth in dark interfaces                    | Not applicable | The application has one light appearance; no dark surface system is claimed.                                                     |
| 63  | Concentric corner radii                     | Not applicable | No nested rounded containers are introduced.                                                                                     |
| 64  | Supporting-icon contrast                    | Not applicable | The revised composition contains no decorative supporting icons.                                                                 |
| 65  | Alignment discipline                        | Pass           | Shared controls align; requester sections share the bounded flow's left edge.                                                    |
| 66  | Comparable numbers align alike              | Pass           | Queue RICE and Reports figures keep their numeric roles and tabular digits.                                                      |
| 67  | Semantic indentation                        | Pass           | Lists indent beneath their named summary fact; candidate feedback stays within its proposal.                                     |
| 68  | Optical alignment                           | Not applicable | No new asymmetric icons or image marks need optical centering.                                                                   |
| 69  | Twelve-column grid                          | Pass           | Three equal landing/filter columns correspond to three four-column regions.                                                      |
| 70  | Columnar layout over stretching             | Pass           | Summary facts use two columns; queue filters use three instead of a stretched orphan.                                            |
| 71  | Content-sized regions                       | Pass           | The sidebar remains 13rem; review and candidate content use bounded widths.                                                      |
| 72  | Centered readable measure                   | Not applicable | These are task workspaces with navigation, not centered long-form reading pages.                                                 |
| 73  | Mobile-first supported layout               | Not applicable | Maz explicitly scoped this pass to desktop, not mobile-first product design.                                                     |
| 74  | Document width containment                  | Pass           | Measured document overflow is zero at 1440, 1280, and 200% default text.                                                         |
| 75  | Content reflow                              | Pass           | Long request content and labels wrap; no line clamps or truncation were added.                                                   |
| 76  | Frozen row and column context               | Not applicable | No internally scrolling table viewport was added; the tested desktop tables fit horizontally and use document scrolling.         |
| 77  | Visible horizontal-overflow cues            | Not applicable | The revised tables fit the tested desktop widths; no offscreen column cue was needed there.                                      |
| 78  | Persistent visible labels                   | Pass           | Fit, rating, date, and queue controls retain visible labels.                                                                     |
| 79  | Field meaning and consequences              | Pass           | Fit is explicitly optional; rating explains the five-point scale; filters name their scope.                                      |
| 80  | Top-aligned field labels                    | Pass           | Ordinary field and filter labels remain above their controls.                                                                    |
| 81  | Placeholder text is supplementary           | Pass           | No placeholder replaces a label in the revised forms.                                                                            |
| 82  | Field width signals expected input          | Pass           | Equal filter roles share bounded columns; paragraph answers use textareas.                                                       |
| 83  | Use textareas for multiline input           | Pass           | A rejection reason remains a multiline field.                                                                                    |
| 84  | Concise, generally useful hint text         | Pass           | The new rejection hint is one short sentence without a trailing period.                                                          |
| 85  | Programmatic descriptions                   | Pass           | Rating hints/errors are linked with aria-describedby; native labels remain associated.                                           |
| 86  | Use appropriate native input attributes     | Pass           | Native date fields, numeric ratings, and optional/required states match their purpose.                                           |
| 87  | Labels and input adornments focus the field | Pass           | Labels use htmlFor or wrap radio inputs; clicking them targets the corresponding control.                                        |
| 88  | Implicit form submission                    | Pass           | Submission remains a form; fit controls save on change without an extra submit action.                                           |
| 89  | Prevent duplicate submission                | Pass           | Submission idempotency and task-rating uniqueness remain covered by domain/browser checks.                                       |
| 90  | Immediate toggle response                   | Pass           | Fit selection updates immediately, then persists; design-note visibility toggles directly.                                       |
| 91  | Visible affordances                         | Pass           | Underlined links, USWDS buttons, and native selects remain identifiable without hover.                                           |
| 92  | Outcome-oriented control labels             | Pass           | Submit request, Save and exit, and Back to summary describe different outcomes.                                                  |
| 93  | Controls near their scope                   | Pass           | Fit controls stay beside their candidate; the rating and Submit are grouped together.                                            |
| 94  | Action consequences stay visible            | Pass           | OIT review and My requests follow-up are explained immediately before sending.                                                   |
| 95  | Button padding ratio                        | Pass           | Existing USWDS button proportions are reused.                                                                                    |
| 96  | Minimum target size                         | Pass           | Native filter height is 40px; rating targets retain their larger labeled hit areas.                                              |
| 97  | Minimum target separation                   | Not applicable | Touch-target separation is outside the explicit desktop scope.                                                                   |
| 98  | Visibility of system status                 | Pass           | Queued/running model work has native progress; fit saving and errors have persistent status.                                     |
| 99  | Contextual feedback                         | Pass           | Fit errors stay with the fit; rating errors stay with the rating; submission confirms in main content.                           |
| 100 | Visual stability across states              | Pass           | Autosave does not scroll the page; only explicit error recovery/submission moves attention.                                      |
| 101 | Actionable empty state                      | Pass           | Empty reviewer work offers requests needing a coordinator; no-match explains OIT routing.                                        |
| 102 | Disclosures are a last resort               | Pass           | Essential summary, fit, gaps, rating, and submission content is not folded away.                                                 |
| 103 | Disclosure signifiers                       | Not applicable | No new disclosure control is introduced in these revised task screens.                                                           |
| 104 | Complete revealed states                    | Pass           | Native menus remain within browser-managed bounds; the changed screens introduce no overlay.                                     |
| 105 | Error prevention                            | Pass           | Undecided is valid; unfinished or failed fit feedback prevents sending until resolved.                                           |
| 106 | Deferred field validation                   | Pass           | Rating errors appear after attempted submission; an unfinished rejection shows guidance rather than an immediate error.          |
| 107 | Inline and summary error messages           | Pass           | The required rating has a persistent inline error and is scrolled into view; summary conflicts remain attached to the edit form. |
| 108 | Persistent error messages                   | Pass           | Browser tests verify the rating message remains until a rating is chosen.                                                        |
| 109 | Preserve input on error                     | Pass           | Failed saves and version conflicts preserve typed values in browser regression tests.                                            |
| 110 | Redundant error cues                        | Pass           | Errors use written messages and error styling; color is not the sole signal.                                                     |
| 111 | Field-identifying error copy                | Pass           | The rating error names the required 1–5 choice; summary conflict text names the summary.                                         |
| 112 | Specific error messages                     | Pass           | Rating omission, failed feedback persistence, and concurrent edits have distinct recovery paths.                                 |
| 113 | Plain-language error messages               | Pass           | The new rating, fit, and summary-recovery messages use ordinary language.                                                        |
| 114 | System failures use page-level errors       | Pass           | Model preparation failure offers retry; connection failures preserve the saved draft instead of asking for invented facts.       |
| 115 | Repeated-error threshold                    | Pass           | Tested recovery paths retry after a corrected condition; no forced repeated invalid-choice loop remains.                         |
| 116 | User control and freedom                    | Pass           | Back to summary and Save and exit remain available; a reviewer can return to the same queue.                                     |
| 117 | Recoverable destructive actions             | Not applicable | The revised screens offer no destructive operation.                                                                              |
| 118 | State persistence across interruption       | Pass           | Browser tests cover reload, saved-work recovery, view switching, and draft resumption.                                           |
| 119 | Confirm only irreversible actions           | Pass           | No confirmation dialog was added for ordinary edits or optional fit opinions.                                                    |
| 120 | Direct-manipulation response time           | Pass           | Native selection changes immediately; delayed network persistence does not delay the displayed choice.                           |
| 121 | Flow-preserving response time               | Pass           | No artificial delay was added to navigation or ordinary controls.                                                                |
| 122 | Progress feedback after one second          | Pass           | Model preparation has a visible, indeterminate progress control through the wait.                                                |
| 123 | Interruptible long-running work             | Pass           | Save and exit interrupts the user's wait while the durable job continues; no invented completion percentage is shown.            |
| 124 | Short interaction animation                 | Not applicable | No new interaction animation is introduced.                                                                                      |
| 125 | Scale animation to the component            | Not applicable | No new animated dialog or press-scale effect is used.                                                                            |
| 126 | No decorative motion on frequent actions    | Pass           | Routine controls have no decorative animation; motion is limited to native in-progress feedback.                                 |
| 127 | Pause offscreen animation                   | Pass           | The native progress element unmounts when its preparation state ends or the user leaves.                                         |
| 128 | Doherty threshold                           | Pass           | Immediate input state is separate from asynchronous persistence; no extra delay precedes user feedback.                          |
| 129 | Design with representative data             | Pass           | Tests cover empty queues, longer content, multiple-candidate fixtures, failed saves, and missing ratings.                        |
| 130 | Text resize to 200%                         | Pass           | Root browser checks found zero overflow at 200% default text on landing, Reports, and the administrator queue.                   |
| 131 | Preserve text tokens                        | Pass           | Names and request facts wrap whole; the new styles add no ellipsis or line clamp.                                                |
| 132 | Defensive handling of user images           | Not applicable | The revised pages accept no user images.                                                                                         |
| 133 | Reliable text contrast over images          | Not applicable | There is no text over an image.                                                                                                  |
| 134 | Preserve image integrity                    | Not applicable | The application pages contain no new raster image; screenshots are QA artifacts only.                                            |
| 135 | No sticky hover on touch                    | Not applicable | Touch interaction is outside this desktop design pass.                                                                           |
| 136 | No obstructive autofocus on touch           | Not applicable | No touch layout or automatic text-input focus is introduced.                                                                     |
| 137 | Full keyboard operability                   | Pass           | Native links/forms/selects remain keyboard-operable; queue return and required-rating focus are exercised.                       |
| 138 | Visible keyboard focus                      | Pass           | Existing USWDS focus outlines remain; no new rule suppresses control focus.                                                      |
| 139 | Programmatic accessible names               | Pass           | Progress, filters, rating inputs, and workflow links have programmatic names.                                                    |
| 140 | Disabled controls do not own essential help | Pass           | Feedback needing completion is explained outside the disabled Submit button.                                                     |
| 141 | Non-interactive tooltips                    | Not applicable | The revised screens do not rely on tooltips.                                                                                     |
| 142 | Accessibility-tree parity                   | Pass           | Visible roles map to headings, labels, status regions, and tables; active navigation carries aria-current.                       |
| 143 | Programmatic state announcements            | Pass           | Waiting, autosave, validation, and submission feedback use persistent status/error regions.                                      |
| 144 | Whole-page composition                      | Pass           | Review content now reads as summary, optional fit, and a distinct final Send section.                                            |
| 145 | Visual-device audit                         | Pass           | The new visual devices are the landing band, proposal grouping/strength, and standard controls.                                  |
| 146 | Repeated-relationship audit                 | Pass           | Filter widths/heights and report baselines have browser assertions; spacing roles are shared.                                    |
| 147 | Interactive-state audit                     | Pass           | Browser acceptance exercises waiting, error, retry, editing, rating, and submission states rather than only screenshots.         |
