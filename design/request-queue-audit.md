# Request queue screen audit

Navigation annotation: September 7, 2026. Original document date not recorded. Historical read-only queue. [The desktop-table audit](desktop-table-audit.md) records the later working-app tables.

Evidence:

- Empty baseline: design/screenshots/00-empty-baseline-1440.png
- Stripped screen: design/screenshots/01-stripped-home-1440.png
- Production desktop: design/screenshots/10-production-final-1440.png
- Production mobile: design/screenshots/11-production-final-400.png
- 200% text: design/screenshots/12-production-final-400-text-200.png
- Runtime checks: no overflow at 320px, 375px, 400px, or 200% text; canonical page redirects; named accessibility tree; keyboard focus; production server.

Human design gate: **pending Maz review**.

Known phase limits:

- Rows are read-only until request detail routes exist.
- Sixty queue rows represent twelve semantic request patterns across five offices.
- Ten stacked rows create a long mobile page; pagination remains available at the bottom.

## Rules

Navigation annotation: the reason recorded for rule 102, “Disclosures are a last resort,” repeats an elevation justification. Its original verdict and reason are retained below; no new assessment of that historical screen is inferred.

| #   | Rule                                        | Result         | Original evidence or reason                                                                                                              |
| --- | ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task clarity                                | Pass           | The H1 and ordered count make the queue task identifiable at first glance.                                                               |
| 2   | Clear primary action                        | Not applicable | The read-only queue's primary task is scanning; no consequential action exists in this phase.                                            |
| 3   | Natural task flow                           | Pass           | Count and order precede the rows; each row presents request, stage/time, then submitter.                                                 |
| 4   | One primary answer per question             | Pass           | Each reviewer question maps once: count/order in the intro and request, stage/time, and submitter in each row.                           |
| 5   | Essential controls only                     | Pass           | The screen exposes only product navigation and pagination; every control changes location or page.                                       |
| 6   | Aesthetic and minimalist design             | Pass           | Chrome shows one header, one intro, one table, and pagination with no decorative panel or duplicate summary.                             |
| 7   | Optimize comprehension, not click count     | Pass           | The queue keeps stage, time, and submitter together instead of splitting them into separate screens.                                     |
| 8   | Consistency and standards                   | Pass           | The screen uses native links and USWDS table, tag, pagination, and button conventions.                                                   |
| 9   | Internal consistency                        | Pass           | Every row repeats the same request, stage/time, and submitter order at both tested widths.                                               |
| 10  | Native semantics first                      | Pass           | The production accessibility tree exposes banner, main, H1, named table, column headers, and named pagination.                           |
| 11  | Safe defaults                               | Pass           | The page is read-only, starts on page 1, and canonicalizes invalid or out-of-range page values.                                          |
| 12  | Match between system and real world         | Pass           | Labels use request, stage, submitter, office, and days rather than schema names.                                                         |
| 13  | Recognition rather than recall              | Pass           | Stage, age, submitter, office, count, order, and current page remain visible in context.                                                 |
| 14  | Clear visual hierarchy                      | Pass           | Header recedes; H1 and the oldest rows dominate the reading order.                                                                       |
| 15  | Use multiple hierarchy cues                 | Pass           | Position, Merriweather heading size, weight, navy chrome, and secondary gray text establish three levels.                                |
| 16  | De-emphasize secondary content              | Pass           | Office names use #565c65, normal weight, and a smaller visual role beneath submitter names.                                              |
| 17  | Contrast follows importance                 | Pass           | Request titles and headings are darkest; office metadata and structural borders are quieter.                                             |
| 18  | Action hierarchy matches consequence        | Pass           | The home action is a USWDS button; pagination is quieter link navigation; no destructive action exists.                                  |
| 19  | Destructive-action hierarchy                | Not applicable | The screen has no destructive action.                                                                                                    |
| 20  | Stable font weight across states            | Pass           | Chrome focus and pagination state change outline/background, not font weight.                                                            |
| 21  | Displayed-data labels earn their place      | Pass           | Column headers name the three repeated roles; no label-value pairs repeat inside desktop cells.                                          |
| 22  | Gestalt proximity                           | Pass           | Stage tags sit with their age, and submitter names sit with offices; row gaps are smaller than section gaps.                             |
| 23  | No horizontal rules                         | Pass           | All visible horizontal boundaries belong to the data table, which the rule explicitly exempts.                                           |
| 24  | Whitespace before other dividers            | Pass           | The intro and table are separated by 2rem of space; no extra rule duplicates that boundary.                                              |
| 25  | Content-driven width                        | Pass           | The intro stops at 66 characters while the table uses the wider measure its rows require.                                                |
| 26  | Spacing and sizing scale                    | Pass           | Page and component gaps use USWDS half-rem spacing tokens and the custom 0.25rem metadata gap.                                           |
| 27  | Design tokens                               | Pass           | Typography, colors, focus, spacing, tags, table, and pagination come from USWDS tokens; custom colors reuse USWDS values.                |
| 28  | Visual-role consistency                     | Pass           | All request titles, stage metadata, submitter names, and office lines use one exact role each.                                           |
| 29  | Limited visual roles                        | Pass           | The page uses a heading, body, strong row title, tag, and secondary metadata—five named text roles.                                      |
| 30  | Bounded fluid sizing                        | Not applicable | No value uses fluid sizing.                                                                                                              |
| 31  | Scale component properties independently    | Pass           | The mobile table changes display and padding without shrinking type, tags, or touch targets.                                             |
| 32  | Intentional visual decisions                | Pass           | Navy identifies product chrome, gray marks secondary metadata, borders delimit rows, and spacing separates sections.                     |
| 33  | Readable body-text size                     | Pass           | Chrome computes ordinary USWDS body text at 16.96px, above the 16px floor.                                                               |
| 34  | Touch input text size                       | Not applicable | The screen has no text input.                                                                                                            |
| 35  | Readable measure                            | Pass           | The page intro is capped at 66ch; long row titles cap at 38ch on desktop and reflow on mobile.                                           |
| 36  | Minimum line height                         | Pass           | USWDS body text uses at least 1.3 line-height and multiline metadata uses 1.4.                                                           |
| 37  | Responsive line height                      | Pass           | The 400px render preserves readable line-height while titles wrap; the H1 keeps its tighter heading role.                                |
| 38  | Tracking follows size and case              | Pass           | Only short tags use uppercase; ordinary and small text retain normal case and default tracking.                                          |
| 39  | Limit emphasized passages                   | Pass           | Bold is limited to headings, column headers, and request titles; paragraphs remain regular weight.                                       |
| 40  | Limited type palette                        | Pass           | The compiled USWDS theme uses Source Sans Pro Web for interface text and Merriweather Web for headings.                                  |
| 41  | Readable font weights                       | Pass           | Body text is 400 and headings/request titles are 700; no thin weight appears.                                                            |
| 42  | Left-align running text                     | Pass           | Intro copy, table content, loading, and error copy share a fixed left edge.                                                              |
| 43  | Typographic baseline alignment              | Pass           | Desktop column headers and single-line row values align on consistent table-cell baselines.                                              |
| 44  | Tabular figures                             | Pass           | Days in stage uses tabular numerals.                                                                                                     |
| 45  | Purposeful typeface selection               | Pass           | USWDS pairs a government-service sans face with a distinct readable heading face.                                                        |
| 46  | Avoid absolute black and white              | Pass           | The page uses #f7f9fa and #1b1b1b for large surfaces/text; white is confined to the table surface.                                       |
| 47  | Coherent neutral palette                    | Pass           | Background, table, metadata, and borders stay within the USWDS cool-gray family.                                                         |
| 48  | Luminance separates palette roles           | Pass           | Navy chrome, off-white page, white table, dark text, and gray metadata differ clearly in luminance.                                      |
| 49  | Defined colour ramps                        | Pass           | Navy, blue focus, and gray roles come from the compiled USWDS color ramps.                                                               |
| 50  | Single primary accent                       | Pass           | USWDS blue is the only interaction accent; navy is reserved for product chrome.                                                          |
| 51  | Do not rely on colour alone                 | Pass           | Every stage is written inside its tag, and the current page uses aria-current in addition to visual styling.                             |
| 52  | Contrast hierarchy                          | Pass           | Measured contrast is 12.8:1 for the brand, 16.31:1 for headings, and 6.74:1 for secondary metadata.                                      |
| 53  | Text contrast                               | Pass           | Measured contrast ranges from 6.72:1 to 17.22:1 across visible text.                                                                     |
| 54  | Purposeful boundaries                       | Pass           | Table lines identify row and header boundaries; the loading box reserves the pending table region.                                       |
| 55  | One visual separator per boundary           | Pass           | Rows use table borders only; sections use space only; the header uses a background change only.                                          |
| 56  | Use borders sparingly                       | Pass           | Borders appear only inside the table and loading placeholder, not around page sections.                                                  |
| 57  | Border contrast                             | Pass           | Table borders at #1b1b1b contrast against both white rows and the off-white page.                                                        |
| 58  | No stacked hard separators                  | Pass           | No page boundary combines a border, shadow, and background change.                                                                       |
| 59  | Consistent elevation system                 | Not applicable | The screen uses no shadow or elevated surface.                                                                                           |
| 60  | Consistent light source                     | Not applicable | The screen uses no shadow or elevated surface.                                                                                           |
| 61  | Shadow blur-to-offset ratio                 | Not applicable | The screen uses no shadow or elevated surface.                                                                                           |
| 62  | Depth in dark interfaces                    | Not applicable | The dark header is flat chrome, not an elevated dark surface.                                                                            |
| 63  | Concentric corner radii                     | Not applicable | No nested rounded surfaces appear.                                                                                                       |
| 64  | Supporting-icon contrast                    | Pass           | Pagination arrows use the same restrained link color as their text and never outrank row content.                                        |
| 65  | Alignment discipline                        | Pass           | The grid container, H1, intro, table, and pagination share the same left edge.                                                           |
| 66  | Comparable numbers align alike              | Not applicable | The screen has no editable number paired with a read-only number.                                                                        |
| 67  | Semantic indentation                        | Pass           | Indentation occurs only inside stacked table cells to show data belonging to one request row.                                            |
| 68  | Optical alignment                           | Pass           | Tags and pagination icons are centered within their controls; text remains left aligned.                                                 |
| 69  | Twelve-column grid                          | Not applicable | The layout uses USWDS content containers, not a column grid.                                                                             |
| 70  | Columnar layout over stretching             | Pass           | Desktop uses three meaningful columns; mobile stacks those roles rather than stretching narrow columns.                                  |
| 71  | Content-sized regions                       | Pass           | The intro stays narrow, request titles cap at 38ch, and the table alone uses the full container.                                         |
| 72  | Centered readable measure                   | Pass           | The USWDS grid centers the screen while the intro preserves a 66-character reading measure.                                              |
| 73  | Mobile-first supported layout               | Pass           | The production layout reflows without clipping at measured 320px, 375px, 400px, and 1440px widths.                                       |
| 74  | Document width containment                  | Pass           | Inner width and document scroll width match at measured 320px, 375px, and 400px phone widths.                                            |
| 75  | Content reflow                              | Pass           | The table stacks at 640px and all long titles remain whole at 400px.                                                                     |
| 76  | Frozen row and column context               | Not applicable | The table never scrolls internally; it stacks below 640px.                                                                               |
| 77  | Visible horizontal-overflow cues            | Not applicable | The page, table, and compact phone pagination do not overflow at 320px, 375px, 400px, or 200% text size.                                 |
| 78  | Persistent visible labels                   | Not applicable | The screen has no text input.                                                                                                            |
| 79  | Field meaning and consequences              | Not applicable | The screen has no form field.                                                                                                            |
| 80  | Top-aligned field labels                    | Not applicable | The screen has no form field.                                                                                                            |
| 81  | Placeholder text is supplementary           | Not applicable | The screen has no placeholder.                                                                                                           |
| 82  | Field width signals expected input          | Not applicable | The screen has no input.                                                                                                                 |
| 83  | Use textareas for multiline input           | Not applicable | The screen has no prose input.                                                                                                           |
| 84  | Concise, generally useful hint text         | Not applicable | The screen has no form hint.                                                                                                             |
| 85  | Programmatic descriptions                   | Not applicable | The screen has no hinted field.                                                                                                          |
| 86  | Use appropriate native input attributes     | Not applicable | The screen has no input.                                                                                                                 |
| 87  | Labels and input adornments focus the field | Not applicable | The screen has no input adornment.                                                                                                       |
| 88  | Implicit form submission                    | Not applicable | The screen has no form.                                                                                                                  |
| 89  | Prevent duplicate submission                | Not applicable | The screen has no submission.                                                                                                            |
| 90  | Immediate toggle response                   | Not applicable | The screen has no toggle.                                                                                                                |
| 91  | Visible affordances                         | Pass           | Navigation controls retain USWDS link and button affordances.                                                                            |
| 92  | Outcome-oriented control labels             | Pass           | Review requests, Previous, Next, and numbered-page labels identify their destinations.                                                   |
| 93  | Controls near their scope                   | Pass           | Pagination sits immediately after the request table and the retry button sits with the error message.                                    |
| 94  | Action consequences stay visible            | Not applicable | The only actions are navigation links.                                                                                                   |
| 95  | Button padding ratio                        | Pass           | Home and retry actions use the USWDS button's established horizontal-to-vertical padding.                                                |
| 96  | Minimum target size                         | Pass           | Numbered pagination targets measure 44 by 44px at phone widths; desktop links exceed the 24px floor.                                     |
| 97  | Minimum target separation                   | Pass           | USWDS pagination spacing separates adjacent targets.                                                                                     |
| 98  | Visibility of system status                 | Pass           | A stable loading composition and page-level error boundary report database state.                                                        |
| 99  | Contextual feedback                         | Pass           | Loading and failure feedback replace the request region and remain beside the route heading.                                             |
| 100 | Visual stability across states              | Pass           | The product header and route heading persist while placeholder rows reserve the queue region.                                            |
| 101 | Actionable empty state                      | Pass           | The empty branch states that no requests are in the queue; this read-only phase has no available creation action.                        |
| 102 | Disclosures are a last resort               | Not applicable | The screen uses no shadow or elevated surface.                                                                                           |
| 103 | Disclosure signifiers                       | Not applicable | The screen has no disclosure.                                                                                                            |
| 104 | Complete revealed states                    | Not applicable | The screen has no menu, tooltip, or disclosure.                                                                                          |
| 105 | Error prevention                            | Pass           | Invalid, negative, array, and out-of-range page values are normalized or redirected before rendering.                                    |
| 106 | Deferred field validation                   | Not applicable | The screen has no form field.                                                                                                            |
| 107 | Inline and summary error messages           | Not applicable | The screen has no field-level validation.                                                                                                |
| 108 | Persistent error messages                   | Not applicable | The screen has no field-level validation.                                                                                                |
| 109 | Preserve input on error                     | Not applicable | The screen has no input.                                                                                                                 |
| 110 | Redundant error cues                        | Not applicable | The screen has no field-level validation.                                                                                                |
| 111 | Field-identifying error copy                | Not applicable | The screen has no field-level validation.                                                                                                |
| 112 | Specific error messages                     | Not applicable | The screen has no field-level validation.                                                                                                |
| 113 | Plain-language error messages               | Pass           | The error boundary states what failed and the next safe action without codes or blame.                                                   |
| 114 | System failures use page-level errors       | Pass           | The route error boundary names the unavailable queue and exposes a retry control.                                                        |
| 115 | Repeated-error threshold                    | Not applicable | The screen has no repeated data-entry requirement.                                                                                       |
| 116 | User control and freedom                    | Not applicable | The screen is read-only and creates no unwanted state.                                                                                   |
| 117 | Recoverable destructive actions             | Not applicable | The screen has no destructive action.                                                                                                    |
| 118 | State persistence across interruption       | Pass           | The queue survived a PostgreSQL container restart with an unchanged database content hash.                                               |
| 119 | Confirm only irreversible actions           | Not applicable | The screen has no irreversible action.                                                                                                   |
| 120 | Direct-manipulation response time           | Pass           | Pagination responded within the normal browser flow without delayed custom interaction.                                                  |
| 121 | Flow-preserving response time               | Pass           | Pagination swaps pages through Next navigation and preserves the product header.                                                         |
| 122 | Progress feedback after one second          | Pass           | The route provides a role=status loading state and stable placeholder rows.                                                              |
| 123 | Interruptible long-running work             | Not applicable | No operation approaches ten seconds.                                                                                                     |
| 124 | Short interaction animation                 | Not applicable | No custom interaction animation exists.                                                                                                  |
| 125 | Scale animation to the component            | Not applicable | No scale animation exists.                                                                                                               |
| 126 | No decorative motion on frequent actions    | Pass           | Pagination has no decorative animation.                                                                                                  |
| 127 | Pause offscreen animation                   | Not applicable | No looping animation exists.                                                                                                             |
| 128 | Doherty threshold                           | Pass           | Unthrottled pagination completed inside the ordinary sub-second navigation path.                                                         |
| 129 | Design with representative data             | Pass           | Sixty database-backed rows cover long titles, seven stages, six pages, loading, error, and empty branches.                               |
| 130 | Text resize to 200%                         | Pass           | At 200% browser text size, first/current/last pagination stays within the viewport and each visible target grows to 80 by 80px.          |
| 131 | Preserve text tokens                        | Pass           | Chrome shows full names, offices, tags, numbers, and long titles without mid-token clipping.                                             |
| 132 | Defensive handling of user images           | Not applicable | The screen displays no user image.                                                                                                       |
| 133 | Reliable text contrast over images          | Not applicable | The screen places no text over an image.                                                                                                 |
| 134 | Preserve image integrity                    | Not applicable | The screen displays no content image.                                                                                                    |
| 135 | No sticky hover on touch                    | Pass           | No hover-only state or control is required at 400px.                                                                                     |
| 136 | No obstructive autofocus on touch           | Pass           | The page does not autofocus.                                                                                                             |
| 137 | Full keyboard operability                   | Pass           | Brand, pagination, Previous, and Next use native links with a logical focus order.                                                       |
| 138 | Visible keyboard focus                      | Pass           | Chrome measured a 4px blue focus outline on every link.                                                                                  |
| 139 | Programmatic accessible names               | Pass           | The table and pagination are named; the current page and links expose distinct names.                                                    |
| 140 | Disabled controls do not own essential help | Not applicable | The screen has no disabled control.                                                                                                      |
| 141 | Non-interactive tooltips                    | Not applicable | The screen has no tooltip.                                                                                                               |
| 142 | Accessibility-tree parity                   | Pass           | The accessibility tree matches the visible banner, main, H1, table, and pagination.                                                      |
| 143 | Programmatic state announcements            | Pass           | Loading copy uses role=status; the error state is a page-level boundary.                                                                 |
| 144 | Whole-page composition                      | Pass           | The production screenshots read as header, queue context, ordered table, then pagination.                                                |
| 145 | Visual-device audit                         | Pass           | The screen uses only background, table borders, tag fill, and focus outline, each tied to chrome, data structure, state, or interaction. |
| 146 | Repeated-relationship audit                 | Pass           | Every row reuses the same three roles and exact USWDS spacing.                                                                           |
| 147 | Interactive-state audit                     | Pass           | Chrome verified focus, page 2 navigation, page 6 clamping, numbered phone pagination, desktop Previous/Next, and current-page state.     |
