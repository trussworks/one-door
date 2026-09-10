# Reviewer interaction review

September 6, 2026. Scope: reviewer/admin tables, request-section navigation,
RICE guidance and count entry, and administrator notes. Human design approval
is pending Maz/design review; automated checks do not certify screen-reader
speech or customer usability.

## Evidence

- [Reader questions](reviewer-ui-questions.md) were recorded before opening the screen implementations.
- `screenshots/reviewer-ui/01-*` capture the original screens at 1440px; `02-*` capture the stripped compositions; `03-*` are intermediate rebuilds.
- `04-*` capture 17 states at 1440px, 1280px, and 1440px with doubled browser-default text. The capture checks the root font before and after each image and document containment. RICE is scrollable at enlarged text; the capture walk advances through all four steps without saving a score.
- `05-navigation-before.png` and `05-navigation-offset.png` isolate the apparent punctuation after History: the text contains no period, but underline fragments beside the descender resemble one. A consistent underline offset removes the fragment.
- [Browser checks](../test/reviewer-interactions.acceptance.ts) cover default and changed sort direction, held responses, document and table offsets, empty/failed results, section focus, numeric entry, and note persistence/retry races. The original requester/reviewer journeys remain in [browser acceptance](../test/browser.acceptance.ts).
- Claude independently inspected the production preview at 1440px/1280px and enlarged text. His empty-result placement and off-screen-sort observations led to the nearby empty message and the sort summary outside the scroller. Inactive columns intentionally have no extra arrow, as Maz requested.

Notes identify the demo visitor who posted them. The freely switchable demo
views are not agency role-based authorization. The new lifecycle examples are
fictional, and their original request content is separate from administrator
comments. Model assessment quality and a separate mobile design are outside
this pass.

## Rule record

| #   | Rule                                        | Result         | Evidence or scoped reason                                                                                                  |
| --- | ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task clarity                                | Pass           | Queue headings name the work; each request section retains its task heading.                                               |
| 2   | Clear primary action                        | Pass           | Add note records a comment; Continue advances a RICE factor; Save score commits the score.                                 |
| 3   | Natural task flow                           | Pass           | Filters precede results; request identity and section navigation precede the selected task.                                |
| 4   | One primary answer per question             | Pass           | The extra order menu is removed; the same sort state drives the heading and outside summary.                               |
| 5   | Essential controls only                     | Pass           | The request-only jump button is removed; existing section links and the next-step action remain.                           |
| 6   | Aesthetic and minimalist design             | Pass           | Sort controls have no link styling or decorative button border; notes use text and space.                                  |
| 7   | Optimize comprehension, not click count     | Pass           | Four RICE steps retain separate explanations without adding a separate score page.                                         |
| 8   | Consistency and standards                   | Pass           | Native buttons, links, forms and tables retain USWDS sizing and appearance.                                                |
| 9   | Internal consistency                        | Pass           | Every sortable header uses the same control and direction treatment.                                                       |
| 10  | Native semantics first                      | Pass           | Headers contain buttons; navigation remains links; comments use a textarea and submit button.                              |
| 11  | Safe defaults                               | Pass           | Queues start with longest waits first; an unsent note remains a private draft.                                             |
| 12  | Match between system and real world         | Pass           | Waits identify business days, and RICE names the unit and period being counted.                                            |
| 13  | Recognition rather than recall              | Pass           | Sort state, active section and saved form values remain visible or recoverable.                                            |
| 14  | Clear visual hierarchy                      | Pass           | Request title, compact status, navigation and section heading form distinct levels.                                        |
| 15  | Use multiple hierarchy cues                 | Pass           | Position, heading size and weight distinguish tasks without adding extra colors.                                           |
| 16  | De-emphasize secondary content              | Pass           | Note authors/times and request identifiers use the existing muted role.                                                    |
| 17  | Contrast follows importance                 | Pass           | Task text and controls are darker than the supporting metadata.                                                            |
| 18  | Action hierarchy matches consequence        | Pass           | Add note is distinct from draft persistence; Save score remains distinct from closing a draft.                             |
| 19  | Destructive-action hierarchy                | Not applicable | These new controls do not delete records or comments; shared reset retains its existing separate confirmation.             |
| 20  | Stable font weight across states            | Pass           | Sorting and section selection do not change font weight.                                                                   |
| 21  | Displayed-data labels earn their place      | Pass           | Wait and Submitted are explicit columns; the wait unit is stated once in the caption.                                      |
| 22  | Gestalt proximity                           | Pass           | Note help stays beside the textarea; RICE help stays with its factor.                                                      |
| 23  | No horizontal rules                         | Pass           | No new page dividers are introduced; native table and protected USWDS navigation boundaries remain.                        |
| 24  | Whitespace before other dividers            | Pass           | Notes are separated by space, not cards or nested borders.                                                                 |
| 25  | Content-driven width                        | Pass           | Note forms stop at 42rem; reading text keeps its existing bounded measure.                                                 |
| 26  | Spacing and sizing scale                    | Pass           | New controls use the existing rem spacing roles; the table retains its 36rem viewport.                                     |
| 27  | Design tokens                               | Pass           | The existing navy, gray, blue and spacing values are reused.                                                               |
| 28  | Visual-role consistency                     | Pass           | Shared Field and SortableHeader components keep repeated labels and controls aligned.                                      |
| 29  | Limited visual roles                        | Pass           | The added roles are note text, author/time, draft feedback and sort state.                                                 |
| 30  | Bounded fluid sizing                        | Not applicable | No new viewport-scaled display type is introduced.                                                                         |
| 31  | Scale component properties independently    | Pass           | Table width, scroller height and text size are controlled separately.                                                      |
| 32  | Intentional visual decisions                | Pass           | The fixed results viewport prevents page shrink; wider columns preserve readable dates and controls.                       |
| 33  | Readable body-text size                     | Pass           | Main copy retains 16px text; the inspected table metadata uses the existing 16.96px role.                                  |
| 34  | Touch input text size                       | Not applicable | Maz excluded a separate mobile design; desktop text enlargement is tested.                                                 |
| 35  | Readable measure                            | Pass           | Request paragraphs retain the 66ch bound; notes use the same reading limit.                                                |
| 36  | Minimum line height                         | Pass           | Body copy retains 1.5 line height; headings use the established tighter roles.                                             |
| 37  | Responsive line height                      | Pass           | Enlarged body copy keeps its relative line height rather than a fixed pixel value.                                         |
| 38  | Tracking follows size and case              | Pass           | Labels remain sentence case with the existing font tracking.                                                               |
| 39  | Limit emphasized passages                   | Pass           | Bold identifies headings, short status labels and authors, not whole note bodies.                                          |
| 40  | Limited type palette                        | Pass           | The existing USWDS font stack is retained.                                                                                 |
| 41  | Readable font weights                       | Pass           | Body text remains regular weight and headings remain bold.                                                                 |
| 42  | Left-align running text                     | Pass           | Notes, guidance and request narratives share a left reading edge.                                                          |
| 43  | Typographic baseline alignment              | Pass           | Header arrows align with labels; filter controls remain aligned in their grid.                                             |
| 44  | Tabular figures                             | Pass           | Score and numeric table cells retain the existing tabular-number treatment.                                                |
| 45  | Purposeful typeface selection               | Pass           | Typography continues to use the requested USWDS system.                                                                    |
| 46  | Avoid absolute black and white              | Pass           | Main content retains off-white surfaces and #1b1b1b text; native fields retain their standard fill.                        |
| 47  | Coherent neutral palette                    | Pass           | Notes reuse #565c65 metadata rather than introducing another neutral family.                                               |
| 48  | Luminance separates palette roles           | Pass           | Navy chrome, dark text and pale warning surfaces retain distinct brightness.                                               |
| 49  | Defined colour ramps                        | Pass           | No independent palette is added for notes or sorting.                                                                      |
| 50  | Single primary accent                       | Pass           | Blue remains the interactive/focus accent.                                                                                 |
| 51  | Do not rely on colour alone                 | Pass           | Sort arrows and aria-sort convey order; current navigation retains an underline and aria-current.                          |
| 52  | Contrast hierarchy                          | Pass           | The active sort uses an arrow rather than a saturated header fill.                                                         |
| 53  | Text contrast                               | Pass           | Changed controls retain the established dark/blue/muted colors on light surfaces.                                          |
| 54  | Purposeful boundaries                       | Pass           | Input borders identify editable fields; note bodies have no enclosing boxes.                                               |
| 55  | One visual separator per boundary           | Pass           | Note entries use spacing, without redundant rules and tinted cards.                                                        |
| 56  | Use borders sparingly                       | Pass           | Borders remain on inputs and tables, not the selected review section.                                                      |
| 57  | Border contrast                             | Pass           | Native field borders remain visible against the form surface.                                                              |
| 58  | No stacked hard separators                  | Pass           | The whole-section focus outline is removed without adding another section border.                                          |
| 59  | Consistent elevation system                 | Not applicable | No new raised surface or shadow is added.                                                                                  |
| 60  | Consistent light source                     | Not applicable | The new elements have no simulated lighting.                                                                               |
| 61  | Shadow blur-to-offset ratio                 | Not applicable | The pass introduces no shadow values.                                                                                      |
| 62  | Depth in dark interfaces                    | Not applicable | This is the existing light USWDS interface, not a dark-mode redesign.                                                      |
| 63  | Concentric corner radii                     | Not applicable | There is no new nested rounded-card arrangement.                                                                           |
| 64  | Supporting-icon contrast                    | Pass           | The direction glyph shares the header's text role and carries meaning rather than decoration.                              |
| 65  | Alignment discipline                        | Pass           | Four reviewer filters share equal columns; the admin view retains its assignment filter.                                   |
| 66  | Comparable numbers align alike              | Pass           | Count and score presentations retain numeric formatting; Reach entry has no fractional stepper.                            |
| 67  | Semantic indentation                        | Pass           | Existing evidence lists remain subordinate to their named sections.                                                        |
| 68  | Optical alignment                           | Pass           | Direction glyphs sit beside the label with a fixed reserved width.                                                         |
| 69  | Twelve-column grid                          | Pass           | RICE retains the existing twelve-column Reach arrangement at desktop widths.                                               |
| 70  | Columnar layout over stretching             | Pass           | Request evidence and RICE inputs retain their bounded column layouts.                                                      |
| 71  | Content-sized regions                       | Pass           | The sidebar and note form retain explicit bounds; wide tables scroll within their own region.                              |
| 72  | Centered readable measure                   | Pass           | The application margins and bounded prose are retained in the rebuilt captures.                                            |
| 73  | Mobile-first supported layout               | Not applicable | A separate mobile design is explicitly outside scope.                                                                      |
| 74  | Document width containment                  | Pass           | All 51 final capture states assert scrollWidth equals the document viewport.                                               |
| 75  | Content reflow                              | Pass           | Enlarged text reflows forms; tables retain internal scrolling rather than widening the document.                           |
| 76  | Frozen row and column context               | Pass           | Table headers and the first column retain sticky context.                                                                  |
| 77  | Visible horizontal-overflow cues            | Pass           | Left/right controls remain visible when columns are hidden; the sort summary stays outside the scroller.                   |
| 78  | Persistent visible labels                   | Pass           | The count, counting unit, period and note textarea all retain visible labels.                                              |
| 79  | Field meaning and consequences              | Pass           | RICE explains any suitable counting unit; note help states its visibility and limit.                                       |
| 80  | Top-aligned field labels                    | Pass           | Labels remain above the inputs in both desktop and enlarged-text captures.                                                 |
| 81  | Placeholder text is supplementary           | Pass           | Essential instructions are labels/hints, not placeholder-only text.                                                        |
| 82  | Field width signals expected input          | Pass           | Reach is short; the unit and period are wider; notes and rationales are multiline.                                         |
| 83  | Use textareas for multiline input           | Pass           | Administrator notes use a textarea with a 2,000-character bound.                                                           |
| 84  | Concise, generally useful hint text         | Pass           | Hints explain a whole-number count, an open unit, and who can see a posted note.                                           |
| 85  | Programmatic descriptions                   | Pass           | Field hints and errors remain connected through aria-describedby.                                                          |
| 86  | Use appropriate native input attributes     | Pass           | Reach is text with numeric inputmode and a digit pattern; note maxlength and required remain enforced.                     |
| 87  | Labels and input adornments focus the field | Pass           | Field labels retain their htmlFor/id association.                                                                          |
| 88  | Implicit form submission                    | Pass           | Notes remain a form with a submit button; textarea Enter retains its multiline meaning.                                    |
| 89  | Prevent duplicate submission                | Pass           | Four concurrent note posts return one note ID and one visible note.                                                        |
| 90  | Immediate toggle response                   | Pass           | Sort/section state updates through the existing controls without a separate Apply step.                                    |
| 91  | Visible affordances                         | Pass           | The active arrow exposes sorting; navigation remains links and note submission remains a button.                           |
| 92  | Outcome-oriented control labels             | Pass           | Add note is distinguished from draft saving; RICE preserves Continue and Save score.                                       |
| 93  | Controls near their scope                   | Pass           | The note action and confirmation stay beside the note field; header buttons act on their columns.                          |
| 94  | Action consequences stay visible            | Pass           | Note help explains internal-view visibility before posting.                                                                |
| 95  | Button padding ratio                        | Pass           | Ordinary actions retain USWDS padding; header buttons use the existing table geometry.                                     |
| 96  | Minimum target size                         | Pass           | Header buttons have a 28px minimum height; ordinary actions retain larger native targets.                                  |
| 97  | Minimum target separation                   | Pass           | Existing action groups retain their rem gaps; header controls remain in separate cells.                                    |
| 98  | Visibility of system status                 | Pass           | Updating text accompanies retained results; Draft saved and Note added describe different states.                          |
| 99  | Contextual feedback                         | Pass           | Note confirmation stays by Add note; no-result feedback appears above the fixed results pane.                              |
| 100 | Visual stability across states              | Pass           | Held reads keep the table mounted; sort tests preserve document, horizontal and vertical table offsets.                    |
| 101 | Actionable empty state                      | Pass           | An empty queue offers coordinator work or clear filters; an empty catalog offers all entries.                              |
| 102 | Disclosures are a last resort               | Pass           | Notes are not hidden in a disclosure; long recorded notes use a bounded scroller.                                          |
| 103 | Disclosure signifiers                       | Pass           | Existing historical details retain native summary controls; no new hidden menu is added.                                   |
| 104 | Complete revealed states                    | Pass           | All four RICE steps can be reached, scrolled, closed and reopened with saved values.                                       |
| 105 | Error prevention                            | Pass           | Non-digit count entry is rejected without conversion; note retries reuse a persisted identifier.                           |
| 106 | Deferred field validation                   | Pass           | Required/empty note validation occurs when posting, not as an error on each keystroke.                                     |
| 107 | Inline and summary error messages           | Pass           | Note validation appears beside the textarea; existing form/server errors remain in their form context.                     |
| 108 | Persistent error messages                   | Pass           | Failed updates leave a visible error and retry action while retaining prior results.                                       |
| 109 | Preserve input on error                     | Pass           | Note and saved-work tests cover lost responses, reloads and edits made after reopening.                                    |
| 110 | Redundant error cues                        | Pass           | Errors retain text and the USWDS alert treatment.                                                                          |
| 111 | Field-identifying error copy                | Pass           | Empty and oversized note messages explicitly name the note.                                                                |
| 112 | Specific error messages                     | Pass           | Empty and over-limit note entries have distinct messages; read failures offer retry.                                       |
| 113 | Plain-language error messages               | Pass           | The UI explains missing notes, size limits and previous results without database error text.                               |
| 114 | System failures use page-level errors       | Pass           | Failed list reads appear above results rather than implying the filter input itself is wrong.                              |
| 115 | Repeated-error threshold                    | Pass           | Identical note retries converge on the stored note rather than making the user repeat the write.                           |
| 116 | User control and freedom                    | Pass           | Section links, back links and RICE draft closure remain available.                                                         |
| 117 | Recoverable destructive actions             | Not applicable | The new note workflow is append-only; it introduces no deletion action.                                                    |
| 118 | State persistence across interruption       | Pass           | Browser tests cover a note draft across reload and a new draft surviving an older post's response.                         |
| 119 | Confirm only irreversible actions           | Pass           | Sorting, navigation and note entry gain no extra confirmation dialog.                                                      |
| 120 | Direct-manipulation response time           | Pass           | Numeric editing is synchronous; note autosave does not block continued typing.                                             |
| 121 | Flow-preserving response time               | Pass           | Read updates retain content instead of replacing the page with a loading composition.                                      |
| 122 | Progress feedback after one second          | Pass           | Updating/Adding note persists while the corresponding response is held open.                                               |
| 123 | Interruptible long-running work             | Not applicable | No determinate long-running task is introduced; model-job behavior is unchanged by this pass.                              |
| 124 | Short interaction animation                 | Pass           | Sorting and section changes add no animation delay.                                                                        |
| 125 | Scale animation to the component            | Not applicable | No scale animation is added.                                                                                               |
| 126 | No decorative motion on frequent actions    | Pass           | Routine table and navigation actions remain unanimated.                                                                    |
| 127 | Pause offscreen animation                   | Not applicable | Notes and sort controls introduce no looping animation.                                                                    |
| 128 | Doherty threshold                           | Pass           | Local editing stays responsive; asynchronous reads show status without removing the task.                                  |
| 129 | Design with representative data             | Pass           | Fixtures cover six phases and several delivery leads; browser checks cover empty, slow, failed and repeated actions.       |
| 130 | Text resize to 200%                         | Pass           | Browser-default 32px captures retain document containment; RICE's internal scroller exposes its controls across all steps. |
| 131 | Preserve text tokens                        | Pass           | Date cells stay unbroken; ordinary narrative wraps without truncation; long note content remains available.                |
| 132 | Defensive handling of user images           | Not applicable | These surfaces add no image input.                                                                                         |
| 133 | Reliable text contrast over images          | Not applicable | No text is placed on images.                                                                                               |
| 134 | Preserve image integrity                    | Not applicable | Screenshots are evidence artifacts, not images embedded in the app.                                                        |
| 135 | No sticky hover on touch                    | Not applicable | Touch-specific behavior is outside the desktop scope.                                                                      |
| 136 | No obstructive autofocus on touch           | Not applicable | No touch autofocus behavior is added.                                                                                      |
| 137 | Full keyboard operability                   | Pass           | Enter sorts while focus stays on the control; section links, RICE and note forms remain keyboard-operable.                 |
| 138 | Visible keyboard focus                      | Pass           | Controls retain focus rings; the non-interactive review section is no longer a focus target.                               |
| 139 | Programmatic accessible names               | Pass           | Sort controls retain names, active columns use aria-sort, and active sections use aria-current.                            |
| 140 | Disabled controls do not own essential help | Pass           | Guidance and pending feedback remain outside disabled controls.                                                            |
| 141 | Non-interactive tooltips                    | Not applicable | No tooltip is introduced for essential guidance or actions.                                                                |
| 142 | Accessibility-tree parity                   | Pass           | Inspected table cells preserve request/agency/status word boundaries; comments retain author and time semantics.           |
| 143 | Programmatic state announcements            | Pass           | Result status, note confirmation, errors and current navigation expose programmatic state; speech is not certified.        |
| 144 | Whole-page composition                      | Pass           | Queue controls precede a stable results area; a request keeps one selected review task.                                    |
| 145 | Visual-device audit                         | Pass           | Arrows mean sort direction, input borders mean editing, and no outline frames an entire selected section.                  |
| 146 | Repeated-relationship audit                 | Pass           | The shared header, field and scroller components keep repeated roles consistent.                                           |
| 147 | Interactive-state audit                     | Pass           | Focused tests cover sort/filter/retry/empty states, section selection, numeric entry and note races.                       |
