# Reviewer and administrator screens: design review

September 5, 2026. Scope: reviewer queue and record sections, catalog attention/comparison, and the new demo controls. This is not a recertification of every older screen.

Human design gate: **pending Maz/design review**. Agent checks do not satisfy that gate. The pass is desktop-focused; screen-reader speech and localization were not certified.

Subsequent correction: temporary DevTools font overrides can be reset during screenshot capture. Do not use this pass's enlarged-text PNGs as the final resize evidence; [the later CSS comparison](css-module-parity.md) provides verified browser-default-font captures. This dated record otherwise remains the historical review of that pass.

## Evidence

- Reader questions: [workflows-four-questions.md](workflows-four-questions.md), written before source changes.
- In `screenshots/workflows-four/`, `01-*-as-found-1440.png` captures the prior queue, record, catalog, dashboard and reports. The new demo-controls destination did not exist; the dashboard capture records its prior navigation.
- `02-record-stripped-1440.png` records the reversible removal of unrelated record sections. `03-queue-1440.png`, `03-catalog-1440.png` and `03-demo-1440.png` record the initial task structure before the final scrolling/state treatment.
- `08-*-1440.png`, `08-*-1280.png` and `09-*-text-200.png` record the final desktop structure and enlarged browser text. `07-live-asset-suggestion.png` and `07-live-service-suggestion.png` show real provider results in the requester screen.
- Browser acceptance covers section persistence, actual restore failure/retry, retained live records, visible overflow controls, and keyboard orientation. API acceptance separately verifies the actor behind a web-initiated reset.

A reported 13px overflow used CSS `body.style.zoom = 2`, which does not reproduce the media-query behavior of browser zoom or enlarged default text. The browser-default-font measurements at 1280px found zero document overflow on the same record. Genuine internal table overflow was retained with visible directional controls and frozen context.

## Remaining limits

The catalog comparison displays all source values but does not automatically highlight differing cells. Assignment lists include demo people and visitor sessions; the current visitor is labeled Me. Seeded risk explanations are illustrative, sometimes templated prose, not evidence that a real model produced them. Live evaluation results and their limitations are recorded separately in the model-quality artifacts. None of these is a claim of OIT user validation.

## Rule record

| #   | Rule                                        | Result         | Evidence or scoped reason                                                                                             |
| --- | ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Task clarity                                | Pass           | Queue scope and next work are visible first; each record section has one named task.                                  |
| 2   | Clear primary action                        | Pass           | The overview links to the next review task; active sections keep their own decision actions.                          |
| 3   | Natural task flow                           | Pass           | Request facts, matching, risk, priority, completion and delivery are separate URL-selected sections.                  |
| 4   | One primary answer per question             | Pass           | Only the selected review section is mounted; the browser test counts absent unrelated sections.                       |
| 5   | Essential controls only                     | Pass           | Scope links replace the duplicate reviewer selector; catalog defaults to work needing attention.                      |
| 6   | Aesthetic and minimalist design             | Pass           | Repeated whole-record summaries and unrelated decision forms no longer occupy the same view.                          |
| 7   | Optimize comprehension, not click count     | Pass           | Section navigation adds useful task boundaries while preserving one request identity.                                 |
| 8   | Consistency and standards                   | Pass           | USWDS buttons, selects, checkboxes, tables and side navigation retain their established behavior.                     |
| 9   | Internal consistency                        | Pass           | Matching and risk use the same evidence-left, decision-right arrangement.                                             |
| 10  | Native semantics first                      | Pass           | Navigation is links, decisions are forms, and comparison data uses native tables.                                     |
| 11  | Safe defaults                               | Pass           | Restore begins unchecked; uncertain requester fit and unscored RICE are never approvals.                              |
| 12  | Match between system and real world         | Pass           | Labels identify requests, matches, risk, next owners and delivery rather than database operations.                    |
| 13  | Recognition rather than recall              | Pass           | Current section, request reference and saved entries remain visible when moving between tasks.                        |
| 14  | Clear visual hierarchy                      | Pass           | Record identity precedes section navigation; section headings precede their evidence and action.                      |
| 15  | Use multiple hierarchy cues                 | Pass           | Position, 36px page headings, 24px sections, weight and blue controls distinguish roles.                              |
| 16  | De-emphasize secondary content              | Pass           | Seed markers and saved-work text recede without reducing ordinary body text below 16px.                               |
| 17  | Contrast follows importance                 | Pass           | Blue emphasizes controls; ordinary evidence remains dark text on a light surface.                                     |
| 18  | Action hierarchy matches consequence        | Pass           | Restoration consequences and confirmation precede its action; normal navigation stays secondary.                      |
| 19  | Destructive-action hierarchy                | Pass           | Shared-example restoration is separate from ordinary work and requires explicit confirmation.                         |
| 20  | Stable font weight across states            | Pass           | Section selection changes underline/background, not text weight or layout width.                                      |
| 21  | Displayed-data labels earn their place      | Pass           | Record metadata names the agency and requester once; risk evidence is labeled where needed.                           |
| 22  | Gestalt proximity                           | Pass           | Evidence and its decision share a grid; each label stays with its own field.                                          |
| 23  | No horizontal rules                         | Pass           | No new page dividers remain; native table and USWDS navigation boundaries are retained.                               |
| 24  | Whitespace before other dividers            | Pass           | Whitespace separates review findings; tint identifies editable decision areas and warnings.                           |
| 25  | Content-driven width                        | Pass           | Prose is bounded at 66ch; the restore task is bounded at 48rem.                                                       |
| 26  | Spacing and sizing scale                    | Pass           | New spacing uses the existing 0.5, 1, 1.5 and 2rem roles.                                                             |
| 27  | Design tokens                               | Pass           | The new controls reuse the existing USWDS blue, navy, gray and spacing values.                                        |
| 28  | Visual-role consistency                     | Pass           | Matching/risk forms share padding, label treatment and action spacing.                                                |
| 29  | Limited visual roles                        | Pass           | The added roles are section navigation, evidence, decision form and secondary status.                                 |
| 30  | Bounded fluid sizing                        | Not applicable | No viewport-scaled display typography or unconstrained fluid type was added.                                          |
| 31  | Scale component properties independently    | Pass           | Table scrolling, control padding and evidence measure are sized separately from type.                                 |
| 32  | Intentional visual decisions                | Pass           | The seven review sections follow distinct tasks; the 7/5 evidence grid separates reading from deciding.               |
| 33  | Readable body-text size                     | Pass           | Measured body text is 16px on indexes and 16.96px in the existing record fieldset.                                    |
| 34  | Touch input text size                       | Not applicable | Touch-specific input behavior is outside the explicitly desktop-focused design scope.                                 |
| 35  | Readable measure                            | Pass           | Long evidence paragraphs retain the application's 66ch maximum.                                                       |
| 36  | Minimum line height                         | Pass           | Measured body line height is 24px at 16px and 25.44px at 16.96px; headings use tighter roles.                         |
| 37  | Responsive line height                      | Pass           | Body/list text keeps 1.5 spacing while page and section headings use 1.2–1.3.                                         |
| 38  | Tracking follows size and case              | Pass           | New control labels use sentence case and no decorative tracking.                                                      |
| 39  | Limit emphasized passages                   | Pass           | Bold distinguishes headings and short evidence labels, not entire model rationales.                                   |
| 40  | Limited type palette                        | Pass           | The existing Source Sans Pro Web stack is used throughout the changed screens.                                        |
| 41  | Readable font weights                       | Pass           | Body text uses regular weight; headings and short labels use the existing heavier role.                               |
| 42  | Left-align running text                     | Pass           | Evidence, source values, questions, answers and forms keep left reading edges.                                        |
| 43  | Typographic baseline alignment              | Pass           | Filter labels and controls share grid alignment; evidence and its form begin in the same row.                         |
| 44  | Tabular figures                             | Pass           | RICE and metric cells retain tabular-number styling.                                                                  |
| 45  | Purposeful typeface selection               | Pass           | Typography comes from the requested USWDS system rather than browser serif defaults.                                  |
| 46  | Avoid absolute black and white              | Pass           | The main surface remains #fdfdfc with #1b1b1b text; native controls retain their standard fill.                       |
| 47  | Coherent neutral palette                    | Pass           | Existing neutral gray roles are reused, including #f5f6f7 decision surfaces.                                          |
| 48  | Luminance separates palette roles           | Pass           | Navy header, blue controls and pale blue/amber states differ in luminance.                                            |
| 49  | Defined colour ramps                        | Pass           | No independent color palette was added to the new sections or controls.                                               |
| 50  | Single primary accent                       | Pass           | Interactive emphasis remains #005ea2.                                                                                 |
| 51  | Do not rely on colour alone                 | Pass           | Current links use aria-current and underline; warnings and overflow also have text.                                   |
| 52  | Contrast hierarchy                          | Pass           | Evidence text and actions have stronger contrast than section structure.                                              |
| 53  | Text contrast                               | Pass           | Existing body, blue-link and muted-text colors retain AA contrast on the light and gray surfaces.                     |
| 54  | Purposeful boundaries                       | Pass           | Tint identifies editable decision forms, stale evidence, or shared-reset consequences.                                |
| 55  | One visual separator per boundary           | Pass           | Evidence/form grids use space; findings no longer have redundant enclosing borders.                                   |
| 56  | Use borders sparingly                       | Pass           | Borders remain on native controls and data tables rather than every content group.                                    |
| 57  | Border contrast                             | Pass           | Native control borders remain visible against white and off-white backgrounds.                                        |
| 58  | No stacked hard separators                  | Pass           | Redundant record-navigation and RICE section separators were removed.                                                 |
| 59  | Consistent elevation system                 | Not applicable | The changed content adds no raised surfaces or drop shadows.                                                          |
| 60  | Consistent light source                     | Not applicable | No new raised/inset surface depends on an implied light direction.                                                    |
| 61  | Shadow blur-to-offset ratio                 | Not applicable | There are no new shadow blur or offset values.                                                                        |
| 62  | Depth in dark interfaces                    | Not applicable | A separate dark-mode design is outside this light USWDS application.                                                  |
| 63  | Concentric corner radii                     | Not applicable | No new nested rounded-card system needs concentric radii.                                                             |
| 64  | Supporting-icon contrast                    | Not applicable | The new task navigation and scroll controls use text rather than decorative icons.                                    |
| 65  | Alignment discipline                        | Pass           | The five reviewer filters align in one row at wide desktop widths and reflow together.                                |
| 66  | Comparable numbers align alike              | Pass           | RICE continues using one numeric editor and one deterministic score display.                                          |
| 67  | Semantic indentation                        | Pass           | List indentation means evidence within a named finding or requirement group.                                          |
| 68  | Optical alignment                           | Pass           | Native checkbox/button geometry is retained; no custom icon requires optical adjustment.                              |
| 69  | Twelve-column grid                          | Pass           | The evidence/decision layout uses twelve columns, split seven and five.                                               |
| 70  | Columnar layout over stretching             | Pass           | Decision fields sit beside bounded evidence rather than stretching across the full record.                            |
| 71  | Content-sized regions                       | Pass           | The sidebar retains its width; restore text and decision fields have content bounds.                                  |
| 72  | Centered readable measure                   | Pass           | Reading stays inside the existing application margins and bounded prose columns.                                      |
| 73  | Mobile-first supported layout               | Not applicable | Maz explicitly excluded a separate mobile design; desktop zoom/reflow remains covered.                                |
| 74  | Document width containment                  | Pass           | The final browser test checks zero document overflow at enlarged browser text size.                                   |
| 75  | Content reflow                              | Pass           | Evidence grids stack at enlarged text sizes; tables scroll inside their own regions.                                  |
| 76  | Frozen row and column context               | Pass           | Scrollable tables retain sticky headers and first-column identity.                                                    |
| 77  | Visible horizontal-overflow cues            | Pass           | Visible left/right controls appear only when columns are hidden and update at the edges.                              |
| 78  | Persistent visible labels                   | Pass           | All new controls have visible labels, including the restoration checkbox.                                             |
| 79  | Field meaning and consequences              | Pass           | Restoration states exactly what changes and what remains; review labels name the decision.                            |
| 80  | Top-aligned field labels                    | Pass           | Ordinary form labels are above their controls; checkbox text is its associated label.                                 |
| 81  | Placeholder text is supplementary           | Pass           | No new placeholder carries essential instructions or replaces a label.                                                |
| 82  | Field width signals expected input          | Pass           | Filters, short numeric RICE inputs, and multiline evidence fields keep distinct widths.                               |
| 83  | Use textareas for multiline input           | Pass           | Reasons, request facts and supporting evidence use textareas.                                                         |
| 84  | Concise, generally useful hint text         | Pass           | New restoration help is normal task content; short field hints remain attached to fields.                             |
| 85  | Programmatic descriptions                   | Pass           | Existing Field and rating helpers retain aria-describedby associations.                                               |
| 86  | Use appropriate native input attributes     | Pass           | Native required/type attributes remain in review, RICE and completion forms.                                          |
| 87  | Labels and input adornments focus the field | Pass           | The restore test activates the visible USWDS checkbox label and verifies checked state.                               |
| 88  | Implicit form submission                    | Pass           | Review and restoration actions are form submissions, not click-only handlers.                                         |
| 89  | Prevent duplicate submission                | Pass           | Pending guards prevent repeated restore activation; workflow idempotency remains tested.                              |
| 90  | Immediate toggle response                   | Pass           | Section/scope selection and checkbox changes respond immediately.                                                     |
| 91  | Visible affordances                         | Pass           | Links are underlined, form controls bounded, and buttons visibly actionable.                                          |
| 92  | Outcome-oriented control labels             | Pass           | Update matching, Update risk assessment, Restore examples and completion labels differ by result.                     |
| 93  | Controls near their scope                   | Pass           | Each decision form stays beside its own evidence, not after all findings.                                             |
| 94  | Action consequences stay visible            | Pass           | Shared-state consequences and preserved-data list remain visible before restoration.                                  |
| 95  | Button padding ratio                        | Pass           | New buttons use the existing USWDS padding rather than custom stretched shapes.                                       |
| 96  | Minimum target size                         | Pass           | Desktop buttons and checkbox-label hit areas exceed the 24px minimum.                                                 |
| 97  | Minimum target separation                   | Pass           | Action groups and table controls retain 1rem gaps between targets.                                                    |
| 98  | Visibility of system status                 | Pass           | Pending, saved, stale, failed and completed states have visible treatments.                                           |
| 99  | Contextual feedback                         | Pass           | Action errors stay with the form; success remains in the prominent main confirmation region.                          |
| 100 | Visual stability across states              | Pass           | Switching sections replaces one region without rebuilding request identity or losing saved edits.                     |
| 101 | Actionable empty state                      | Pass           | Empty queues offer coordinator work; empty catalog filters offer all entries.                                         |
| 102 | Disclosures are a last resort               | Pass           | Active review evidence is not folded; long historical detail remains separate from current work.                      |
| 103 | Disclosure signifiers                       | Pass           | Historical disclosures retain native summary controls; review sections are explicit links.                            |
| 104 | Complete revealed states                    | Pass           | The existing RICE dialog and section panels retain complete, dismissible states.                                      |
| 105 | Error prevention                            | Pass           | Restoration cannot be submitted before consent; server validation still enforces prerequisites.                       |
| 106 | Deferred field validation                   | Pass           | Review validation occurs on submission; typing is not declared erroneous mid-entry.                                   |
| 107 | Inline and summary error messages           | Pass           | Existing shared field/rating helpers preserve inline and summary validation.                                          |
| 108 | Persistent error messages                   | Pass           | Restoration failure remains visible until another attempt; entered review reasons persist.                            |
| 109 | Preserve input on error                     | Pass           | The section-navigation test preserves an unfinished reason through Back and reload.                                   |
| 110 | Redundant error cues                        | Pass           | Warnings/errors include text and USWDS treatments, not color alone.                                                   |
| 111 | Field-identifying error copy                | Pass           | Required reasons and task ratings retain field-specific labels and messages.                                          |
| 112 | Specific error messages                     | Pass           | Version conflicts, missing ratings, stale assessments and quota limits have distinct explanations.                    |
| 113 | Plain-language error messages               | Pass           | New status/help text avoids raw database codes and explains the next available action.                                |
| 114 | System failures use page-level errors       | Pass           | Preparation failures and limits are visible within the relevant review section.                                       |
| 115 | Repeated-error threshold                    | Pass           | Provider retries remain bounded; stale edits require explicit reconciliation.                                         |
| 116 | User control and freedom                    | Pass           | Browser Back, section links, queue return links and dialog close remain available.                                    |
| 117 | Recoverable destructive actions             | Pass           | Restoration requires fresh consent and preserves historical evidence rather than promising undo.                      |
| 118 | State persistence across interruption       | Pass           | The browser test verifies persistence while changing sections immediately after typing.                               |
| 119 | Confirm only irreversible actions           | Pass           | Normal navigation and edits have no extra confirmation; shared reset is the consequential exception.                  |
| 120 | Direct-manipulation response time           | Pass           | Native typing and selections update locally without waiting for a database round trip.                                |
| 121 | Flow-preserving response time               | Pass           | Autosave retains the existing 450ms debounce without blocking continued work.                                         |
| 122 | Progress feedback after one second          | Pass           | Preparation and restoration expose progress while waiting for server completion.                                      |
| 123 | Interruptible long-running work             | Not applicable | The provider supplies no meaningful percentage; the agreed design uses indeterminate progress and saved return paths. |
| 124 | Short interaction animation                 | Not applicable | No new application-authored interaction animation was introduced.                                                     |
| 125 | Scale animation to the component            | Not applicable | There is no new pressed-scale or dialog-entry animation.                                                              |
| 126 | No decorative motion on frequent actions    | Pass           | Routine navigation, filters and scrolling have no decorative transition delay.                                        |
| 127 | Pause offscreen animation                   | Pass           | Preparation indicators unmount when their section is left; table cues are static.                                     |
| 128 | Doherty threshold                           | Pass           | Local selection feedback is immediate; visible status covers actual asynchronous work.                                |
| 129 | Design with representative data             | Pass           | Checks include empty lists, long evidence, saved-work interruption, failure, stale data and enlarged text.            |
| 130 | Text resize to 200%                         | Pass           | 200% browser-default text is tested; CSS body.zoom was rejected as a substitute for browser/text reflow.              |
| 131 | Preserve text tokens                        | Pass           | Request names and evidence wrap; wide table values remain available through explicit scrolling.                       |
| 132 | Defensive handling of user images           | Not applicable | No user-image upload or arbitrary image container is part of these changes.                                           |
| 133 | Reliable text contrast over images          | Not applicable | No new text is placed over images.                                                                                    |
| 134 | Preserve image integrity                    | Not applicable | Evidence screenshots are retained as native captures, not resized into product content.                               |
| 135 | No sticky hover on touch                    | Not applicable | Touch hover behavior is outside the explicitly desktop-focused pass.                                                  |
| 136 | No obstructive autofocus on touch           | Not applicable | Touch autofocus is outside scope; desktop section focus is tested.                                                    |
| 137 | Full keyboard operability                   | Pass           | Native controls and section links work by keyboard; the skip link remains first.                                      |
| 138 | Visible keyboard focus                      | Pass           | USWDS controls retain visible focus; changed sections receive a visible focused region.                               |
| 139 | Programmatic accessible names               | Pass           | Sections, tables, checkbox and scroll controls have programmatic names.                                               |
| 140 | Disabled controls do not own essential help | Pass           | Consent text, review prerequisites and pending/error states explain disabled controls nearby.                         |
| 141 | Non-interactive tooltips                    | Not applicable | No tooltip is used to contain interactive or required content.                                                        |
| 142 | Accessibility-tree parity                   | Pass           | Section links expose their current state and the accessible tree follows displayed task order.                        |
| 143 | Programmatic state announcements            | Pass           | Status regions, alerts, aria-current and focus communicate state; screen-reader speech is not certified.              |
| 144 | Whole-page composition                      | Pass           | Current work, evidence and decision form now form one composition per section.                                        |
| 145 | Visual-device audit                         | Pass           | Blue identifies actions, pale gray identifies editable decisions, amber identifies cautions/notes.                    |
| 146 | Repeated-relationship audit                 | Pass           | Repeated decision forms, filter grids and scroll controls share the same style rules.                                 |
| 147 | Interactive-state audit                     | Pass           | Browser journeys cover navigation, editing, failure, restoration, scoring, completion and delivery.                   |
