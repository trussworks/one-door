# Desktop table review

September 6, 2026. Scope: queue composition and shared table sorting, overflow,
and pagination interactions. The catalog, dashboard and reports were also
checked for regressions in those shared controls. This is not a fresh audit of
every form or the unchanged application shell. Human design approval remains
pending Maz/design review.

## Evidence

The [reader questions](desktop-table-questions.md) preceded source inspection.
`screenshots/desktop-tables/01-*` records the original 1440px queue;
`02-*` records removal of the scroll buttons; `03-*` and `04-*` are development
iterations. `05-*` records the production reviewer queue, administrator queue,
catalog, dashboard and reports at 1280px, 1440px and 1440px with a real 32px
browser-default font. The default font was checked before and after capture.

All five screens fit their desktop content region at normal text: 960px at
1280px and 1120px at 1440px. At doubled text the two eight-column queues use
1608px within a 1344px scroller; the document does not overflow. Other captured
tables fit at doubled text. The queue keeps 16px primary text and 14px secondary
metadata, with 1.5 line height. No information is truncated to achieve the fit.

The queue now shows all 22 reference assignments, the administrator queue all
29 reference requests, and the catalog all 55 entries without pagination.
These counts describe the isolated capture database, not visitor activity in
the working demo. The backend integration test grows its own database through
100 and 101 requests and verifies global filtering, sorting, totals and page
clamping. Browser checks exercise the 100+1 page composition separately.

Pointer clicks have no outline on sort buttons or table regions. Keyboard
focus stays visible and arrow keys scroll the native overflow region. The
indicator above an overflowing table changes with its scroll position; it is
not a button. This follows Maz's explicit preference over the skill's default
requirement for an operable overflow cue. No new package or custom scrolling
command was added.

Claude independently inspected the production screens and identified a remaining
pointer-focus outline on the shared queue-scope and request-section links. The
shared link style now follows the same pointer/keyboard distinction as the table
controls. `06-*` captures the pointer and keyboard treatments for both link groups;
the browser suite includes both regressions. Claude's separate observation that
the fixed-height queue could show more rows is an optional layout preference,
not a missing page: every result remains in the native vertical scroller.

## Verification

- [Strict harness report](desktop-table-harness.json): seven checks passed; supported trip probes caught their deliberate violations and restored cleanly.
- Unit checks: 100 tests passed, including pagination boundaries, global catalog ordering and saved-work interaction sequences.
- Production browser checks: all 35 journeys passed, including pointer versus keyboard focus for headers, regions and navigation links.
- Database checks: all 19 exposed integration commands passed on isolated databases, including historical fixture upgrades and the 100/101-row queue check.
- The production image built and passed the container check for migrations, non-root execution, the demo gate, a database-backed page and worker startup.
- Claude inspected the production composition independently and rechecked the link-focus correction. Session status confirmed `fable (claude-fable-5)`; an older model name in a commit credit was static session text.

No schema, fixture or model-prompt change was needed. GitHub CI and issues were
left alone as requested. A separate mobile design and screen-reader speech
certification remain outside this pass.

## Rule record

Pass means the changed scope meets the rule in the recorded renders or named
interaction checks. Not applicable identifies a capability outside this table
change, not a claim that the whole application lacks that capability.

| #   | Rule                                        | Result         | Evidence or scoped reason                                                                                                    |
| --- | ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task clarity                                | Pass           | Requests to review leads into assignments, filters and actionable rows.                                                      |
| 2   | Clear primary action                        | Pass           | Request titles remain links into the review task.                                                                            |
| 3   | Natural task flow                           | Pass           | Scope selection precedes filters, result count and rows.                                                                     |
| 4   | One primary answer per question             | Pass           | Column arrows and the outside sort summary share one sort state; the summary serves enlarged-text users.                     |
| 5   | Essential controls only                     | Pass           | Custom scrolling buttons are removed; page controls appear only above 100 matches.                                           |
| 6   | Aesthetic and minimalist design             | Pass           | The long yellow RICE warning becomes a short line near the scores.                                                           |
| 7   | Optimize comprehension, not click count     | Pass           | All ordinary-size results are present without repeated page changes.                                                         |
| 8   | Consistency and standards                   | Pass           | Native scrolling replaces the custom left/right commands.                                                                    |
| 9   | Internal consistency                        | Pass           | Queue, catalog, dashboard and reports share the same sort controls.                                                          |
| 10  | Native semantics first                      | Pass           | Tables contain th/button controls, linked request titles and native scroll regions.                                          |
| 11  | Safe defaults                               | Pass           | The queue still opens longest-wait first, with the matching descending arrow.                                                |
| 12  | Match between system and real world         | Pass           | Waits identify business days; rows retain the next action and responsible person.                                            |
| 13  | Recognition rather than recall              | Pass           | Active filters and sort remain visible and survive reload.                                                                   |
| 14  | Clear visual hierarchy                      | Pass           | Titles and next actions lead; identifiers, agencies and counting bases recede.                                               |
| 15  | Use multiple hierarchy cues                 | Pass           | Position, link styling, bold next actions and smaller metadata distinguish roles.                                            |
| 16  | De-emphasize secondary content              | Pass           | Queue metadata uses 14px muted text while primary cells stay 16px.                                                           |
| 17  | Contrast follows importance                 | Pass           | Primary text is darker than identifiers and counting bases.                                                                  |
| 18  | Action hierarchy matches consequence        | Pass           | Opening a request and editing its RICE estimate remain distinct controls.                                                    |
| 19  | Destructive-action hierarchy                | Not applicable | Sorting, filtering and paging do not delete or overwrite request data.                                                       |
| 20  | Stable font weight across states            | Pass           | Sort state changes the arrow and aria-sort, not the label's weight.                                                          |
| 21  | Displayed-data labels earn their place      | Pass           | Wait units are stated once; cell values do not repeat column headings.                                                       |
| 22  | Gestalt proximity                           | Pass           | Metadata remains directly below its request, person, action or score.                                                        |
| 23  | No horizontal rules                         | Pass           | No page dividers were added; existing USWDS table and shell boundaries are retained.                                         |
| 24  | Whitespace before other dividers            | Pass           | The RICE caution is ordinary text rather than another boxed region.                                                          |
| 25  | Content-driven width                        | Pass           | Intrinsic column sizing replaces the queue's forced 64rem minimum.                                                           |
| 26  | Spacing and sizing scale                    | Pass           | Queue cells use 0.5rem padding and existing 1rem/0.875rem type roles.                                                        |
| 27  | Design tokens                               | Pass           | The existing text, muted, surface and focus colors are reused.                                                               |
| 28  | Visual-role consistency                     | Pass           | Every queue row uses the same primary and metadata styles; headers share one component.                                      |
| 29  | Limited visual roles                        | Pass           | The queue adds no badge, icon family or new type role.                                                                       |
| 30  | Bounded fluid sizing                        | Not applicable | No viewport-scaled display typography is introduced.                                                                         |
| 31  | Scale component properties independently    | Pass           | Cell padding changes independently of readable primary text size.                                                            |
| 32  | Intentional visual decisions                | Pass           | More width goes to request titles; the active arrow retains its own intrinsic width.                                         |
| 33  | Readable body-text size                     | Pass           | The desktop browser test requires primary queue cells to remain at least 16px.                                               |
| 34  | Touch input text size                       | Not applicable | Maz explicitly requested a desktop application.                                                                              |
| 35  | Readable measure                            | Pass           | Introductory prose remains bounded; rows contain short facts rather than full summaries.                                     |
| 36  | Minimum line height                         | Pass           | Changed queue text and metadata use 1.5 line height.                                                                         |
| 37  | Responsive line height                      | Pass           | Relative line height grows with doubled browser text.                                                                        |
| 38  | Tracking follows size and case              | Pass           | Sentence-case labels keep the existing USWDS tracking.                                                                       |
| 39  | Limit emphasized passages                   | Pass           | Bold is confined to headings and short next-action labels.                                                                   |
| 40  | Limited type palette                        | Pass           | The established USWDS typeface is retained.                                                                                  |
| 41  | Readable font weights                       | Pass           | Primary and secondary values remain regular weight; headings remain bold.                                                    |
| 42  | Left-align running text                     | Pass           | Titles, agency names and counting bases retain a constant left reading edge.                                                 |
| 43  | Typographic baseline alignment              | Pass           | Sort arrows align with the first line of their labels, including Coordinator.                                                |
| 44  | Tabular figures                             | Pass           | Wait, submission date and RICE cells use tabular figures.                                                                    |
| 45  | Purposeful typeface selection               | Pass           | The requested USWDS system remains the typography source.                                                                    |
| 46  | Avoid absolute black and white              | Pass           | Queue text uses #1b1b1b against the existing off-white surface.                                                              |
| 47  | Coherent neutral palette                    | Pass           | Supporting text uses the existing #565c65 neutral.                                                                           |
| 48  | Luminance separates palette roles           | Pass           | Navy shell, dark primary text and muted metadata remain visibly distinct.                                                    |
| 49  | Defined colour ramps                        | Pass           | No new color is introduced in the changed components.                                                                        |
| 50  | Single primary accent                       | Pass           | Links and keyboard focus keep the established blue accent.                                                                   |
| 51  | Do not rely on colour alone                 | Pass           | Arrow direction and aria-sort identify order independently of color.                                                         |
| 52  | Contrast hierarchy                          | Pass           | Sorting does not fill the active column with a saturated color.                                                              |
| 53  | Text contrast                               | Pass           | Existing dark text, muted metadata and blue links remain above AA on the off-white/striped cells.                            |
| 54  | Purposeful boundaries                       | Pass           | Table row boundaries distinguish records; pointer clicks add no boundary.                                                    |
| 55  | One visual separator per boundary           | Pass           | The removed warning box no longer repeats the spacing around its guidance.                                                   |
| 56  | Use borders sparingly                       | Pass           | No custom border surrounds the table or resting sort heading.                                                                |
| 57  | Border contrast                             | Pass           | Remaining table boundaries use the established USWDS table treatment.                                                        |
| 58  | No stacked hard separators                  | Pass           | No new nested frame or divider is introduced.                                                                                |
| 59  | Consistent elevation system                 | Not applicable | Changed table components use no elevation.                                                                                   |
| 60  | Consistent light source                     | Not applicable | No raised or inset surface is introduced.                                                                                    |
| 61  | Shadow blur-to-offset ratio                 | Not applicable | Changed table components use no shadows.                                                                                     |
| 62  | Depth in dark interfaces                    | Not applicable | This application exposes a single light content appearance.                                                                  |
| 63  | Concentric corner radii                     | Not applicable | No nested rounded containers are added.                                                                                      |
| 64  | Supporting-icon contrast                    | Pass           | Small direction arrows do not compete with their bold text labels.                                                           |
| 65  | Alignment discipline                        | Pass           | Headers and primary values share the same cell padding.                                                                      |
| 66  | Comparable numbers align alike              | Pass           | Numeric cells retain the same alignment across scored and unscored records.                                                  |
| 67  | Semantic indentation                        | Pass           | Metadata aligns beneath its parent value instead of acquiring a separate arbitrary inset.                                    |
| 68  | Optical alignment                           | Pass           | The arrow is visible beside Coordinator without overlapping the next heading.                                                |
| 69  | Twelve-column grid                          | Not applicable | Table columns size by content; this is not a horizontal page grid.                                                           |
| 70  | Columnar layout over stretching             | Pass           | Eight distinct queue facts remain columns, not long single-cell paragraphs.                                                  |
| 71  | Content-sized regions                       | Pass           | The scroller stays within the main content region at every captured width.                                                   |
| 72  | Centered readable measure                   | Not applicable | This is a data table, not an ordinary reading page; introductory prose keeps its existing bound.                             |
| 73  | Mobile-first supported layout               | Not applicable | Maz explicitly excluded mobile design.                                                                                       |
| 74  | Document width containment                  | Pass           | All 15 production captures assert zero document overflow.                                                                    |
| 75  | Content reflow                              | Pass           | Desktop headers fit; enlarged queues scroll internally without cutting stored text.                                          |
| 76  | Frozen row and column context               | Pass           | Sticky table headers and the request column retain identity during internal scrolling.                                       |
| 77  | Visible horizontal-overflow cues            | Pass           | A top-right text/arrow indicator tracks the hidden side; native scrolling replaces buttons as Maz requested.                 |
| 78  | Persistent visible labels                   | Pass           | Queue filters retain visible Phase, Next action, RICE status and Risk labels.                                                |
| 79  | Field meaning and consequences              | Pass           | Filter names match the row facts they narrow.                                                                                |
| 80  | Top-aligned field labels                    | Pass           | Filter labels remain above their native selects.                                                                             |
| 81  | Placeholder text is supplementary           | Pass           | Catalog search has a persistent Find an item label.                                                                          |
| 82  | Field width signals expected input          | Not applicable | No new text-entry field is added; existing filter geometry remains unchanged.                                                |
| 83  | Use textareas for multiline input           | Not applicable | Changed table controls contain no multiline entry.                                                                           |
| 84  | Concise, generally useful hint text         | Pass           | The RICE caution is two short sentences, beside the table it qualifies.                                                      |
| 85  | Programmatic descriptions                   | Not applicable | No new field hint or validation message is introduced.                                                                       |
| 86  | Use appropriate native input attributes     | Pass           | Filters stay native selects and catalog search remains a text input.                                                         |
| 87  | Labels and input adornments focus the field | Pass           | Existing filter label/id associations are retained.                                                                          |
| 88  | Implicit form submission                    | Not applicable | Filtering applies on change; there is no new submission form.                                                                |
| 89  | Prevent duplicate submission                | Not applicable | Changed controls only read data; write-path regressions run separately.                                                      |
| 90  | Immediate toggle response                   | Pass           | Heading selection updates direction without a separate Apply action.                                                         |
| 91  | Visible affordances                         | Pass           | The default active arrow exposes sorting; row links retain underlines.                                                       |
| 92  | Outcome-oriented control labels             | Pass           | Page controls, when present, still say Previous page and Next page.                                                          |
| 93  | Controls near their scope                   | Pass           | Sort controls remain inside their column headers.                                                                            |
| 94  | Action consequences stay visible            | Pass           | Sorting and filtering change only which records are shown and their order.                                                   |
| 95  | Button padding ratio                        | Pass           | Ordinary page controls retain USWDS styling; header buttons follow table geometry.                                           |
| 96  | Minimum target size                         | Pass           | Header controls retain a 28px minimum height.                                                                                |
| 97  | Minimum target separation                   | Pass           | Header controls remain separated by cell padding; filters retain their grid gaps.                                            |
| 98  | Visibility of system status                 | Pass           | Delayed reads show Updating while retaining the existing rows.                                                               |
| 99  | Contextual feedback                         | Pass           | No-result and read-error feedback stay above the results pane.                                                               |
| 100 | Visual stability across states              | Pass           | Tests retain the same table node and document/table offsets through held and completed sort requests.                        |
| 101 | Actionable empty state                      | Pass           | Empty queue and catalog filters offer their existing recovery actions beside the count.                                      |
| 102 | Disclosures are a last resort               | Pass           | No queue field or RICE counting basis is hidden in a disclosure.                                                             |
| 103 | Disclosure signifiers                       | Not applicable | Changed table controls introduce no disclosure.                                                                              |
| 104 | Complete revealed states                    | Pass           | Overflow exposes the remaining columns through native scrolling rather than a clipped menu.                                  |
| 105 | Error prevention                            | Pass           | Page numbers clamp to available results; filters reset the requested page.                                                   |
| 106 | Deferred field validation                   | Not applicable | No newly validated text field is introduced.                                                                                 |
| 107 | Inline and summary error messages           | Not applicable | Table reads have one page-level error, not field-level validation.                                                           |
| 108 | Persistent error messages                   | Pass           | Failed reads leave a visible retry action and the previous rows.                                                             |
| 109 | Preserve input on error                     | Pass           | Filter selections stay in the URL when a read fails.                                                                         |
| 110 | Redundant error cues                        | Pass           | Existing error text and alert treatment remain together.                                                                     |
| 111 | Field-identifying error copy                | Not applicable | A failed table read is not an error in a particular input.                                                                   |
| 112 | Specific error messages                     | Pass           | The retained-results failure explicitly says the previous results are still shown.                                           |
| 113 | Plain-language error messages               | Pass           | Read failure uses existing user-facing text rather than raw API codes.                                                       |
| 114 | System failures use page-level errors       | Pass           | Read errors remain above results instead of blaming a filter value.                                                          |
| 115 | Repeated-error threshold                    | Pass           | The controlled read-failure test recovers on one retry after service is restored.                                            |
| 116 | User control and freedom                    | Pass           | Filters can be cleared, sorts reversed and opened records return to their queue context.                                     |
| 117 | Recoverable destructive actions             | Not applicable | No changed control destroys records.                                                                                         |
| 118 | State persistence across interruption       | Pass           | Sort and filter URLs survive reload and record return.                                                                       |
| 119 | Confirm only irreversible actions           | Pass           | No confirmation dialog is added to sorting, paging or filtering.                                                             |
| 120 | Direct-manipulation response time           | Pass           | Native scrolling has no scripted motion or timer.                                                                            |
| 121 | Flow-preserving response time               | Pass           | Pending result reads keep the prior table visible rather than flashing a loading page.                                       |
| 122 | Progress feedback after one second          | Pass           | The held-response test observes Updating and aria-busy.                                                                      |
| 123 | Interruptible long-running work             | Not applicable | This pass adds no long-running write or model task.                                                                          |
| 124 | Short interaction animation                 | Pass           | Sorting, filtering and paging add no animation.                                                                              |
| 125 | Scale animation to the component            | Not applicable | No scaling animation exists in these controls.                                                                               |
| 126 | No decorative motion on frequent actions    | Pass           | Header changes do not animate the table away and back.                                                                       |
| 127 | Pause offscreen animation                   | Not applicable | Changed controls contain no looping animation.                                                                               |
| 128 | Doherty threshold                           | Pass           | Local catalog sorting and native scrolling impose no artificial delay.                                                       |
| 129 | Design with representative data             | Pass           | Tests and captures cover all reference records, empty results, 100/101 results, held reads, failures and enlarged text.      |
| 130 | Text resize to 200%                         | Pass           | Real doubled-font captures preserve document containment and operable internal overflow.                                     |
| 131 | Preserve text tokens                        | Pass           | Dates stay together; headers have no clipping; no ellipsis or line clamp hides request text.                                 |
| 132 | Defensive handling of user images           | Not applicable | Queue records do not render uploaded images.                                                                                 |
| 133 | Reliable text contrast over images          | Not applicable | No changed text overlays images.                                                                                             |
| 134 | Preserve image integrity                    | Not applicable | Evidence screenshots are not embedded in the application UI.                                                                 |
| 135 | No sticky hover on touch                    | Not applicable | Touch-device design is outside the requested scope.                                                                          |
| 136 | No obstructive autofocus on touch           | Not applicable | No autofocus or touch workflow is introduced.                                                                                |
| 137 | Full keyboard operability                   | Pass           | Enter activates sort; Tab reaches headers; arrow keys move native overflow.                                                  |
| 138 | Visible keyboard focus                      | Pass           | Real Shift-Tab produces a solid outline while pointer activation does not.                                                   |
| 139 | Programmatic accessible names               | Pass           | Header buttons retain Sort by names, and the selected th retains aria-sort.                                                  |
| 140 | Disabled controls do not own essential help | Pass           | Page position is visible outside disabled Previous/Next controls.                                                            |
| 141 | Non-interactive tooltips                    | Not applicable | The overflow indicator is visible text, not a tooltip.                                                                       |
| 142 | Accessibility-tree parity                   | Pass           | Native column headings, row links, active sort and result status retain their programmatic roles.                            |
| 143 | Programmatic state announcements            | Pass           | Result status and aria-busy remain in place; screen-reader speech has not been certified.                                    |
| 144 | Whole-page composition                      | Pass           | Scope and filters lead to one stable results pane; custom scroll/pagination clutter is gone.                                 |
| 145 | Visual-device audit                         | Pass           | Arrows represent order or overflow; pointer clicks no longer add unexplained boxes.                                          |
| 146 | Repeated-relationship audit                 | Pass           | Every queue row shares cell padding and metadata roles; every sortable table uses the shared header.                         |
| 147 | Interactive-state audit                     | Pass           | Browser checks cover pointer/keyboard focus, all heading arrows, sort/filter stability, empty/error recovery and pagination. |
