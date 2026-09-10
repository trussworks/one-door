# Focus behavior and administrator note placement

Navigation annotation: September 7, 2026. Original document date not recorded. Historical focus and note-layout review. The verification section preserves the release hold recorded in that pass; its current disposition is not established here.

Scope: a shared pointer/keyboard focus correction and Maz's specified two-column
administrator request layout. No copy, workflow, schema or model prompt changed.
Human design approval remains pending Maz's review.

## Evidence and limits

- The cause was read in the bundled USWDS stylesheet: its base `:focus` rule outlines links, inputs, buttons and focusable regions. Checkbox/radio outlines are painted on the adjacent label's `::before`.
- The initial mouse-only policy was insufficient: browsers also mark clicked text fields `:focus-visible`. The current policy removes blue focus indicators in both modalities. Entry fields use a 2px neutral inset stroke; other keyboard controls use a 2px neutral outline, light against the dark header. Existing input borders, validation and selected backgrounds remain.
- A production style sweep inspected 551 pointer targets across 20 pages/states. Default click actions were suppressed during that sweep to avoid accidental submissions; it proves style coverage, not that 551 business actions completed. Separate browser tests exercise actual navigation, input and save behavior.
- `screenshots/focus-policy/01-*` shows the original clicked dashboard counter. `02-*` and `03-*` show pointer and keyboard states at normal and doubled browser-default text.
- `04-notes-before-1440.png` records the old arrangement. `04-notes-after-1440.png` and `04-notes-after-1280.png` show request content first, with the note form to the right. The measured request heading moved from y=950 to y=449 at 1440px; both new column headings align at y=449.
- The note's saved-work identity and posting behavior are unchanged. Reviewer notes remain read-only and keep their existing order. Narrow or enlarged-text layouts stack the columns to retain readability.
- The focus suite requires keyboard focus on the intended control, including the actual checkbox input when its label is clicked. This is not screen-reader speech certification.
- `screenshots/neutral-focus/01-*` records the remaining blue textarea outline; `02-*` and `03-*` show the actual note field focused by mouse and keyboard without it. `04-*` shows keyboard focus against the dark header. A second sweep checked 571 targets on 21 routes/states, including active entry fields; ordinary blue button borders/hover styling were not treated as focus indicators.

## Verification

Verification recorded during this pass: all 50 production browser journeys passed, including
14 focus regressions, invalid-field preservation and the note-column geometry
check. All 100 unit tests and all 19 database integration commands passed on
isolated databases. The production image passed the container check.

The secret-scan finding was a credential exposure, not a false positive.
The local database credential appeared in tracked files and published history;
Entire recordings also contained credentials. The release was held during this pass while
credential rotation, history cleanup and publication safeguards are verified.
No scanner exception is appropriate.

Claude independently inspected the dashboard, navigation, checkbox pseudo-element
and note-column layouts at 1440px, 1280px and doubled browser text, then ran
the 11 focus tests against the combined preview. No unresolved defect remains
from that review. At enlarged text the note column stacks after the request;
the immediate side-by-side view applies to the normal desktop layout.

GitHub CI and issues were left alone as requested.

The record applies to the changed focus and note-layout states, not a new
certification of every unchanged screen.

## Rule record

| #   | Rule                                        | Result         | Evidence or scoped reason                                                                                                   |
| --- | ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task clarity                                | Pass           | Request needs appear at the beginning of the administrator view, beside notes.                                              |
| 2   | Clear primary action                        | Pass           | The existing Add note action remains directly beneath the note field.                                                       |
| 3   | Natural task flow                           | Pass           | The administrator reads the request before reaching the note form in DOM order.                                             |
| 4   | One primary answer per question             | Pass           | One note form remains; there is no duplicated editor above the request.                                                     |
| 5   | Essential controls only                     | Pass           | No controls were added; three local focus exceptions were removed.                                                          |
| 6   | Aesthetic and minimalist design             | Pass           | Mouse-only outlines disappear without adding another visual device.                                                         |
| 7   | Optimize comprehension, not click count     | Pass           | Note entry and request reading now share one screen position.                                                               |
| 8   | Consistency and standards                   | Pass           | Browser :focus-visible replaces mouse-specific component exceptions.                                                        |
| 9   | Internal consistency                        | Pass           | Dashboard, navigation, table and form controls share one focus policy.                                                      |
| 10  | Native semantics first                      | Pass           | CSS handles modality; no blur handlers or keyboard-tracking JavaScript were added.                                          |
| 11  | Safe defaults                               | Pass           | Keyboard focus uses contrasting neutral outlines; active entry fields use an inset stroke.                                  |
| 12  | Match between system and real world         | Pass           | The note still identifies its reviewer audience beside the field.                                                           |
| 13  | Recognition rather than recall              | Pass           | Request context remains visible while the administrator enters a note.                                                      |
| 14  | Clear visual hierarchy                      | Pass           | Request content leads on the left; notes occupy a smaller right column.                                                     |
| 15  | Use multiple hierarchy cues                 | Pass           | Position and column width distinguish primary reading from note entry.                                                      |
| 16  | De-emphasize secondary content              | Pass           | Existing gray hint and draft-status roles remain beneath the note label.                                                    |
| 17  | Contrast follows importance                 | Pass           | Removing pointer rings stops incidental focus from overpowering the selected state.                                         |
| 18  | Action hierarchy matches consequence        | Pass           | Add note remains distinct from the draft-save status.                                                                       |
| 19  | Destructive-action hierarchy                | Not applicable | No destructive action was added or changed.                                                                                 |
| 20  | Stable font weight across states            | Pass           | Focus changes neither font weight nor control dimensions.                                                                   |
| 21  | Displayed-data labels earn their place      | Pass           | No extra labels were introduced with the right-hand column.                                                                 |
| 22  | Gestalt proximity                           | Pass           | Note label, visibility hint, input, save status and action remain grouped.                                                  |
| 23  | No horizontal rules                         | Pass           | The columns use a gap, not a new dividing line.                                                                             |
| 24  | Whitespace before other dividers            | Pass           | No card, shadow or enclosing border was added around the notes column.                                                      |
| 25  | Content-driven width                        | Pass           | Notes use a 21rem column; request content takes the remaining readable width.                                               |
| 26  | Spacing and sizing scale                    | Pass           | The column gap uses the existing 2rem spacing unit.                                                                         |
| 27  | Design tokens                               | Pass           | Focus uses existing charcoal/white colors at 2px; spacing and control dimensions remain unchanged.                          |
| 28  | Visual-role consistency                     | Pass           | All pointer-quiet controls follow the same global selector.                                                                 |
| 29  | Limited visual roles                        | Pass           | The change introduces no new typography or color role.                                                                      |
| 30  | Bounded fluid sizing                        | Not applicable | No fluid display typography was introduced.                                                                                 |
| 31  | Scale component properties independently    | Pass           | Only column arrangement changes; text is not scaled to fit.                                                                 |
| 32  | Intentional visual decisions                | Pass           | Both section headings align; the note no longer displaces the request introduction.                                         |
| 33  | Readable body-text size                     | Pass           | Existing readable text sizes remain unchanged in desktop screenshots.                                                       |
| 34  | Touch input text size                       | Not applicable | A separate touch/mobile design is outside the desktop scope.                                                                |
| 35  | Readable measure                            | Pass           | Summary facts become one column when their actual container is narrow.                                                      |
| 36  | Minimum line height                         | Pass           | Request prose and list items retain their existing 1.5 line-height treatment.                                               |
| 37  | Responsive line height                      | Pass           | Doubled browser text reflows instead of clipping either column.                                                             |
| 38  | Tracking follows size and case              | Not applicable | Letter spacing and capitalization were not changed.                                                                         |
| 39  | Limit emphasized passages                   | Pass           | Existing emphasis is retained; no long passage receives new emphasis.                                                       |
| 40  | Limited type palette                        | Pass           | The existing USWDS typeface remains in use.                                                                                 |
| 41  | Readable font weights                       | Pass           | No font weights were changed.                                                                                               |
| 42  | Left-align running text                     | Pass           | Both request text and note entry retain left alignment.                                                                     |
| 43  | Typographic baseline alignment              | Pass           | The note and request headings share the same measured top position.                                                         |
| 44  | Tabular figures                             | Not applicable | No numeric display or score calculation was changed.                                                                        |
| 45  | Purposeful typeface selection               | Pass           | The requested USWDS typography remains unchanged.                                                                           |
| 46  | Avoid absolute black and white              | Pass           | The established off-white content surface and dark text remain unchanged.                                                   |
| 47  | Coherent neutral palette                    | Pass           | Hint/status text retains the existing neutral gray.                                                                         |
| 48  | Luminance separates palette roles           | Pass           | Selected backgrounds remain visible without a pointer focus outline.                                                        |
| 49  | Defined colour ramps                        | Pass           | The change adds no color values.                                                                                            |
| 50  | Single primary accent                       | Pass           | Links keep the blue accent; focus uses quieter neutral indicators.                                                          |
| 51  | Do not rely on colour alone                 | Pass           | Selection backgrounds, link underlines and checked states remain independent of focus.                                      |
| 52  | Contrast hierarchy                          | Pass           | Pointer focus no longer competes with dashboard figures.                                                                    |
| 53  | Text contrast                               | Pass           | Text colors and surfaces remain unchanged; keyboard-outline contrast is tested at a minimum of 3:1.                         |
| 54  | Purposeful boundaries                       | Pass           | Input borders and selected states remain; incidental click frames do not.                                                   |
| 55  | One visual separator per boundary           | Pass           | Notes are separated from the request by one column gap.                                                                     |
| 56  | Use borders sparingly                       | Pass           | No new panel border was added.                                                                                              |
| 57  | Border contrast                             | Pass           | Existing field borders were not removed by the focus policy.                                                                |
| 58  | No stacked hard separators                  | Pass           | No new separator is stacked around the note form.                                                                           |
| 59  | Consistent elevation system                 | Not applicable | No elevation effect was introduced.                                                                                         |
| 60  | Consistent light source                     | Not applicable | No raised or inset surface was introduced.                                                                                  |
| 61  | Shadow blur-to-offset ratio                 | Not applicable | No shadow was introduced.                                                                                                   |
| 62  | Depth in dark interfaces                    | Not applicable | The application has no separate dark-content appearance.                                                                    |
| 63  | Concentric corner radii                     | Not applicable | No nested rounded container was added.                                                                                      |
| 64  | Supporting-icon contrast                    | Not applicable | No new supporting icon was added.                                                                                           |
| 65  | Alignment discipline                        | Pass           | The desktop browser test requires both headings to align within one pixel.                                                  |
| 66  | Comparable numbers align alike              | Pass           | The focus policy does not change numeric alignment.                                                                         |
| 67  | Semantic indentation                        | Pass           | The note form remains a single group beside, not indented into, the request.                                                |
| 68  | Optical alignment                           | Pass           | The desktop render shows aligned headings and complete form controls.                                                       |
| 69  | Twelve-column grid                          | Not applicable | The specified layout is two content columns, not a horizontal page grid.                                                    |
| 70  | Columnar layout over stretching             | Pass           | The administrator reads request content in the left column and enters notes on the right.                                   |
| 71  | Content-sized regions                       | Pass           | The note column is bounded; the request column can shrink without document overflow.                                        |
| 72  | Centered readable measure                   | Pass           | Existing prose measure is retained within the request column.                                                               |
| 73  | Mobile-first supported layout               | Not applicable | Maz explicitly excluded mobile design.                                                                                      |
| 74  | Document width containment                  | Pass           | Desktop alignment tests and enlarged-text inspection find no document overflow.                                             |
| 75  | Content reflow                              | Pass           | Container queries collapse narrow summary facts to one column without truncation.                                           |
| 76  | Frozen row and column context               | Pass           | Existing sticky table context is unchanged and remains covered by browser tests.                                            |
| 77  | Visible horizontal-overflow cues            | Pass           | The existing native table scrolling and directional hint are unchanged.                                                     |
| 78  | Persistent visible labels                   | Pass           | The note and all filter/input labels remain visible.                                                                        |
| 79  | Field meaning and consequences              | Pass           | The note hint still states its audience and 2,000-character limit.                                                          |
| 80  | Top-aligned field labels                    | Pass           | The note label stays above the textarea.                                                                                    |
| 81  | Placeholder text is supplementary           | Pass           | The label and hint do not depend on placeholder text.                                                                       |
| 82  | Field width signals expected input          | Pass           | The note field remains multiline in its bounded side column.                                                                |
| 83  | Use textareas for multiline input           | Pass           | The note remains a textarea with its existing character limit.                                                              |
| 84  | Concise, generally useful hint text         | Pass           | The existing short visibility/length hint stays with the textarea.                                                          |
| 85  | Programmatic descriptions                   | Pass           | The Field component retains its label and description associations.                                                         |
| 86  | Use appropriate native input attributes     | Pass           | Input types and attributes were not changed by the global focus policy.                                                     |
| 87  | Labels and input adornments focus the field | Pass           | Checkbox label clicks focus the actual input; the label pseudo-element follows that input.                                  |
| 88  | Implicit form submission                    | Pass           | The note remains a native form with a submit button.                                                                        |
| 89  | Prevent duplicate submission                | Pass           | Existing note retry and concurrent-post browser checks remain in the full run.                                              |
| 90  | Immediate toggle response                   | Pass           | Checkbox/radio selection still changes normally; focus styling alone is suppressed.                                         |
| 91  | Visible affordances                         | Pass           | Links keep underlines and buttons keep their normal treatment.                                                              |
| 92  | Outcome-oriented control labels             | Pass           | Add note and the existing navigation labels are unchanged.                                                                  |
| 93  | Controls near their scope                   | Pass           | The note action stays immediately below the input and draft feedback.                                                       |
| 94  | Action consequences stay visible            | Pass           | The visibility hint remains above Add note in the new column.                                                               |
| 95  | Button padding ratio                        | Pass           | Existing USWDS button padding remains unchanged.                                                                            |
| 96  | Minimum target size                         | Pass           | Focus styling changes no hit area.                                                                                          |
| 97  | Minimum target separation                   | Pass           | The note action and field retain their existing spacing.                                                                    |
| 98  | Visibility of system status                 | Pass           | Draft saved and Note added remain distinct feedback states.                                                                 |
| 99  | Contextual feedback                         | Pass           | Note validation and confirmation stay beside the form.                                                                      |
| 100 | Visual stability across states              | Pass           | The focus policy changes no geometry; existing sort/section stability tests remain.                                         |
| 101 | Actionable empty state                      | Pass           | The empty note form still has its label, hint and Add note action.                                                          |
| 102 | Disclosures are a last resort               | Pass           | The note form is not hidden in a disclosure.                                                                                |
| 103 | Disclosure signifiers                       | Pass           | Existing disclosure markers remain unchanged when clicked.                                                                  |
| 104 | Complete revealed states                    | Pass           | The RICE focus test opens, advances and closes the real dialog.                                                             |
| 105 | Error prevention                            | Pass           | The note's existing size/empty checks are retained.                                                                         |
| 106 | Deferred field validation                   | Pass           | No validation timing was changed.                                                                                           |
| 107 | Inline and summary error messages           | Pass           | The note's existing field and form messages stay with the moved input.                                                      |
| 108 | Persistent error messages                   | Pass           | No error styling or persistence behavior was removed.                                                                       |
| 109 | Preserve input on error                     | Pass           | Existing draft, lost-response and reopened-note tests remain in the full suite.                                             |
| 110 | Redundant error cues                        | Pass           | Focusing an invalid note preserves its error message, aria-invalid state and original field border.                         |
| 111 | Field-identifying error copy                | Pass           | Existing note validation messages still identify the note.                                                                  |
| 112 | Specific error messages                     | Pass           | Existing empty-note and size-limit messages are unchanged.                                                                  |
| 113 | Plain-language error messages               | Pass           | No new user-facing copy or raw error text was added.                                                                        |
| 114 | System failures use page-level errors       | Pass           | Existing page-level read errors are unaffected.                                                                             |
| 115 | Repeated-error threshold                    | Not applicable | This change adds no new error condition or retry path.                                                                      |
| 116 | User control and freedom                    | Pass           | Section navigation and draft closure retain their current behavior.                                                         |
| 117 | Recoverable destructive actions             | Not applicable | This change adds no destructive action.                                                                                     |
| 118 | State persistence across interruption       | Pass           | The note retains its existing request-specific saved-work key and persistence logic.                                        |
| 119 | Confirm only irreversible actions           | Pass           | Moving the note form introduces no new confirmation.                                                                        |
| 120 | Direct-manipulation response time           | Pass           | Native focus styling is synchronous and requires no event listener.                                                         |
| 121 | Flow-preserving response time               | Pass           | The change adds no request, delay or loading state.                                                                         |
| 122 | Progress feedback after one second          | Not applicable | This change adds no asynchronous operation.                                                                                 |
| 123 | Interruptible long-running work             | Not applicable | This change adds no long-running operation.                                                                                 |
| 124 | Short interaction animation                 | Pass           | No focus or layout animation was added.                                                                                     |
| 125 | Scale animation to the component            | Not applicable | No scaling animation exists in the changed components.                                                                      |
| 126 | No decorative motion on frequent actions    | Pass           | Mouse and keyboard focus changes have no decorative motion.                                                                 |
| 127 | Pause offscreen animation                   | Not applicable | No looping animation exists in the changed components.                                                                      |
| 128 | Doherty threshold                           | Not applicable | No data fetching or computation was added.                                                                                  |
| 129 | Design with representative data             | Pass           | The latest sweep covered 571 targets on 21 routes/states, including active text-entry fields.                               |
| 130 | Text resize to 200%                         | Pass           | Production captures include a real doubled browser-default font; columns reflow.                                            |
| 131 | Preserve text tokens                        | Pass           | No text is truncated or line-clamped to make the note column fit.                                                           |
| 132 | Defensive handling of user images           | Not applicable | No image input is involved.                                                                                                 |
| 133 | Reliable text contrast over images          | Not applicable | No text overlays an image.                                                                                                  |
| 134 | Preserve image integrity                    | Not applicable | The screenshots are review artifacts, not in-app images.                                                                    |
| 135 | No sticky hover on touch                    | Not applicable | Touch-specific behavior is outside the requested desktop scope.                                                             |
| 136 | No obstructive autofocus on touch           | Not applicable | No autofocus behavior was added.                                                                                            |
| 137 | Full keyboard operability                   | Pass           | Tests use real Tab/Shift-Tab and require focus to return to the intended control.                                           |
| 138 | Visible keyboard focus                      | Pass           | Keyboard navigation uses neutral outlines; active input/textarea/select fields use neutral inset strokes.                   |
| 139 | Programmatic accessible names               | Pass           | Native elements, accessible names and label associations are unchanged.                                                     |
| 140 | Disabled controls do not own essential help | Pass           | Note guidance remains visible outside disabled controls.                                                                    |
| 141 | Non-interactive tooltips                    | Not applicable | No tooltip was added.                                                                                                       |
| 142 | Accessibility-tree parity                   | Pass           | Request content precedes the side note form in the administrator's DOM order.                                               |
| 143 | Programmatic state announcements            | Pass           | Existing saved-work and confirmation live regions are unchanged.                                                            |
| 144 | Whole-page composition                      | Pass           | The administrator's request introduction and note form are visible together.                                                |
| 145 | Visual-device audit                         | Pass           | The shared policy removes incidental outlines, not selection or input borders.                                              |
| 146 | Repeated-relationship audit                 | Pass           | One global policy now replaces component-by-component mouse fixes.                                                          |
| 147 | Interactive-state audit                     | Pass           | Focus regressions cover pointer/keyboard note entry, field errors, controls on light/dark surfaces and native form widgets. |
