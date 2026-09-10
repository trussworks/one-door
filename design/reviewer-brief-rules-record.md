# Reviewer brief: screen-design rules record

## Current validation: automated accessibility

JSX accessibility rules now run with `npm run lint`. Axe checks run with
`npm run test:a11y` and are included in the ordinary browser suite. The
configured rules cover WCAG A/AA through 2.2 and axe best practices. Tests
prove that the lint configuration and browser engine reject inaccessible
examples and accept their repaired equivalents.

The completed run contains 37 axe scans across 26 tests, with zero violations.
Coverage includes public pages, authenticated lists and detail pages, expanded
review and question controls, administrator history, a submitted requester's
record, the completion form and rating error, and a coarse-pointer phone view.
All 99 browser tests and 500 unit tests pass. Existing focus, touch-target,
and zoom checks remain active.

The scans identified and verified repairs to landmark names and containment,
heading levels, rating-group error semantics, estimate-hint contrast, and
small disclosure targets. Fine-pointer summaries now have a 24-pixel minimum;
the existing 44-pixel coarse-pointer minimum remains. Nine desktop visual
baselines changed only by the resulting vertical spacing. All 52 comparisons
pass at zero difference after inspection; text200 baselines are unchanged.

Sanitized JSON reports retain unresolved contrast checks, chiefly native
controls and decorative indicators. These are manual-review findings, not
automatic passes. CI retains the reports on successful and failed runs.
Evidence is in `.harness/accessibility-20260910/`, with visual comparisons in
`.harness/accessibility-20260910-claude-crops/`. **Human accessibility and design
review remain pending.**

## Previous validation: remaining review work

The completion area uses fixed messages selected from the existing review and
draft states. It makes no model call. Under “Needed to complete review,” each
section with remaining work gets one narrative paragraph. Policy findings is
plain text; the other section references link to their headings. Sections
without remaining work are omitted. The section anchors used
by existing queue links remain available.

An unfinished edit is described with the open decision in its own section.
Preparation problems take precedence over decisions on an unavailable or
outdated assessment; a catalog eligibility problem remains explicit. Questions
are described only when present, without repeating a finding's information
request. An incomplete priority draft still holds completion, while an untouched
missing estimate does not. Recording and completion use the existing commands
and requirements.

The text was drafted in a fresh Codex context from functional facts. Its inputs
and two authored revisions remain under
`.harness/reviewer-copy-20260909/author/completion-summary*`. Claude reviewed
state attribution and completion-gate equivalence without authoring copy.
Root verification evidence is retained under
`.harness/reviewer-completion-summary-20260909/`.

The rendered summary passes at 1440 pixels, 390 pixels with a coarse pointer,
and 200-percent text. The section links focus their target headings and measure
at least 44 pixels in both dimensions on a coarse pointer. Paragraphs remain
separate without horizontal overflow. Incomplete option and estimate drafts
change the relevant paragraph; restoring the drafts restores the prior summary.

All 493 unit tests and 73 browser scenarios pass. The browser run initially
found two old-copy expectations in the empty-assessment scenario; updating
those assertions and rerunning the scenario verified its full completion and
later-priority workflow. All 52 screenshot comparisons pass at zero difference.
Only the two assessment baselines changed, confined to the completion region.
Rendered evidence is in the UI worktree's
`.harness/reviewer-copy-rendered-20260909/v18/`.

**Human review remains pending.**

## Previous validation: the review catalog frame

Catalog search now has one page heading, its request title as context, and one
return control. The review heading, stage, next action, and history reference
are hidden while the catalog is open. The same request frame owns the mode, so
its heading and working surface cannot disagree. The review stays mounted to
retain its drafts and open panels.

Reference links and link-styled buttons inherit the app font. History and
section-return references share their text size; the catalog return also
inherits the same weight and line height. The rendered frame was checked at
1440 pixels, 390 pixels with a coarse pointer, and 200-percent text. No document
overflow occurred.

Opening catalog search focuses the search field and scrolls to the top.
Returning restores the originating control and scroll position, with the URL
and typed review work intact. Adding an option returns only after the recording
operation and draft update finish. The regression delays the catalog draft
write before checking restored focus; the earlier callback order fails that
check. A detached origin does not receive a later scroll or focus operation.

The catalog subview now has two visual baselines of its own. The parity suite
executes 52 comparisons across its six tests. Existing review, delivery, and
history behavior remains covered by the workflow suite. Evidence is retained
under root `.harness/reviewer-catalog-frame-20260909/` and the UI worktree's
`.harness/reviewer-copy-rendered-20260909/v16/` and `v17/`.

The heading and return label reuse existing Codex-authored copy; the request
title remains stored content. This adjustment changes presentation and the
return timing, not request decisions, permissions, or completion requirements.
**Human review remains pending.**

## Previous validation: option and policy-finding rows (build-v15)

Maz requested separate policy-finding lines, then one introductory sentence
followed directly by the existing options, with each status following its text
when space permits. Build-v15 implements those changes on the existing review
page. It also names the highlighted options and policy findings explicitly in
the opening instruction.

- Both sections use unbulleted lists. Each row contains one native button and,
  when opened, its own evidence and decision panel. The panel appears below
  the selected row's summary; later rows move down in normal flow. Only one
  claim panel opens at a time.
- The native button contains highlighted summary text followed by its status;
  policy findings also include severity. Inline text fragments let the status
  follow the final wrapped text line when it fits. The status remains part of
  the button's accessible name. Native Enter and Space activation are retained.
- Fit has one count sentence for all options. The ordinal narration and separate
  added-options introduction are removed. Each option's evidence panel retains
  its source and human attribution. Draft keys, recorded decisions, questions,
  completion requirements, and the queue's score-link behavior are unchanged.
- The user's legal-hold example passes at 1440, 700, 390, and 200-percent text.
  The measured long summaries wrap across four lines at 390 pixels, with the
  status on the final line when room remains. No document overflow occurs.
  Parent hover highlights the text from the full target, and coarse targets
  remain separate.
- All 72 browser scenarios pass. The new tests cover separate rows, panel
  placement, a single open panel, trailing statuses, accessible status names,
  and native keyboard activation. All 50 executed screenshot comparisons pass
  at zero difference; only the two assessment baselines changed, with the same
  fixture identity.

The two fresh Codex authoring outputs are retained under
`.harness/reviewer-copy-20260909/author/` as
`claim-guidance-clarity.json` and `options-intro-clarity.json`. Rendered evidence
is in the UI worktree's `.harness/reviewer-copy-rendered-20260909/v15/`;
root test and release evidence is in `.harness/reviewer-finding-lines-20260909/`.
The earlier rule inventory applies to unchanged components; this section
supersedes its paragraph-layout and claim-name descriptions. **Human review
remains pending.**

## Previous validation: control boundaries and action labels (build-v13)

Maz identified a missing search-field border, touching wrapped buttons, and
confusing recording/completion labels on September 9, 2026. Build-v13 corrects
those findings within the existing page structure. American spelling is now
recorded in `REPO_RULES.md` and used in the authored interface copy.

- Search field: pass. The standalone input restores the right border that
  USWDS removes for an attached search button. Its right and left borders both
  measure 1 pixel; its float is none; the field fits its container at 1440 and
  390 pixels.
- Decision groups: pass. Fit, risk, and completion controls share a wrapping
  flex layout with a 12-pixel gap. A 700-pixel risk view forces wrapping; a
  390-pixel coarse-pointer view includes the restore action. Both retain the
  gap without overlapping controls. The measured coarse targets meet 44 pixels.
- Action labels: pass for distinct names and unchanged behavior. The fresh
  Codex author supplied “Record progress” and “Complete first review.” The first
  records decisions while leaving review open; the second also completes first
  review under the existing requirements. No action or completion guard changed.
- Catalog spelling: pass. Authored display strings use American spelling;
  internal identifiers and stored content retain their existing values.
- Regression coverage: pass. The new boundary test fails on the previous
  build's absent search border and passes on build-v13. All 70 browser
  scenarios pass, including partial recording, completion, follow-up, and
  recovery.
- Visual comparisons: pass. All 50 executed comparisons pass at zero pixel
  difference. The UTC date rollover required a new fixture. Forty-six
  authenticated screenshots were refreshed, including changed visitor names;
  those identity differences are not counted as interface changes.

Evidence: root `.harness/reviewer-controls-20260909/` contains the red and
passing browser runs, source-equivalence receipt, and check results. The UI
worktree's `.harness/reviewer-copy-rendered-20260909/v13/` contains the
rendered measurements and screenshots. The two action labels came from
`.harness/reviewer-copy-20260909/author/review-action-clarity.json`; the author
received behavioral facts without the existing labels.

The earlier rule inventory below remains historical evidence for unchanged
components. This repair updates the affected form, spacing, copy, and responsive
checks; it does not certify user comprehension. **The human design gate remains
pending.**

## Previous validation: independent copy correction (build-v12)

The current page is build-v12, checked on September 9, 2026. Codex
independently authored the replacement copy under the isolation process in
`reviewer-copy-authorship.md`. The approved prose layout and workflow remain
in place. Earlier sections below are historical evidence: their quoted wording,
version names, and measurements do not describe the current page unless this
section explicitly carries the relevant check forward.

The correction changes wording, draft summaries, optional-field declarations,
and responsive control sizing. It does not change the assessment sequence,
review commands, data model, assignment rules, or completion requirements.
The historical rule inventory remains useful for unchanged structure and
shared components; the following checks replace its claims about copy and
changed controls.

| Area                          | Current evidence and result                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy ownership                | Pass: a fresh Codex context received factual requirements without the existing wording. Inputs, first draft, revisions, and integration mapping are retained in `.harness/reviewer-copy-20260909/`.                                                                                                                                          |
| Page structure                | Pass: the rendered correction keeps prose claims, inline editing, four estimate lines, one recording area, and a quiet history reference. No peer tabs or standing next-step links return. The v9 accessibility snapshots record resting, opened, and closed states.                                                                         |
| State and recovery text       | Pass: 69 browser scenarios exercise changed drafts, recorded decisions, missing and unavailable priority data, optional questions, unknown answers, stale versions, failed saves, legacy draft recovery, completed review, and closed requests. A collapsed changed estimate states both the action and value.                               |
| Touch targets                 | Pass: the v11 measurements and v12 shared-control regression cover the brief, expanded delivery forms, history controls, administrator notes, and shell at a coarse pointer. Measured targets meet 44 pixels in both dimensions; taps are not forced.                                                                                        |
| Responsive forms              | Pass: the fieldset and control sizing fixes keep expanded delivery forms within the 390-pixel document width. The check compares document scroll width with client width, since a mobile layout viewport can expand and make an inner-width comparison misleading.                                                                           |
| Historical score table        | Pass on v12: opening both score disclosures leaves document client width and scroll width at 390 pixels. The table has one named, focusable horizontal scroll region; the table scrolls inside that region. The prior v11 58-pixel overflow is resolved.                                                                                     |
| Visual comparisons            | Pass on v12: six test cases execute 50 screenshot comparisons at zero pixel difference. The current baselines reflect the independent copy. Forty-six were refreshed after replacing an expired fixture; those differences included visitor identity, not just presentation. Twenty retained historical PNGs are outside the executed suite. |
| Keyboard and accessible names | Pass for the exercised controls: the browser focus suite passes with the new labels. The score-table region uses its caption as its accessible name and has `tabindex="0"`. Existing native controls and return paths remain reachable.                                                                                                      |
| Human comprehension           | Pending: the checks cannot establish whether people understand the wording or need repeated attempts. Maz's review remains separate from agent validation.                                                                                                                                                                                   |

Rendered evidence is in the UI worktree at
`.harness/reviewer-copy-rendered-20260909/`: `v9/aria-v9-resting.txt`,
`v9/aria-v9-panel-open.txt`, `v9/aria-v9-closed.txt`,
`v9/draft-summary-v9.txt`, `v11/coarse-v11.txt`, and
`v12/history-table-v12.txt` with its screenshot. The root checkout retains
`browser-v12.log`, `final-checks.json`, container and shutdown logs, and the
independent authoring record under `.harness/reviewer-copy-20260909/`.

The ordinary browser run logged two interrupted HTTP connections. A disposable
instrumented copy of the same build identified `Error: aborted` in Node's
`abortIncoming`/`socketOnClose` stack. Three repeated lifecycle journeys passed
and received no response with status 500 or higher. The browser ledger recorded
navigation cancellations; it did not establish a specific API route. The
instrumented build is retained as diagnostic evidence and is not deployed.

**Human design gate: pending.** No automated result approves the wording on
Maz's behalf. The historical usability observations below are not a substitute
for reviewing the corrected page.

## Historical prototype-fidelity comparison (build-v3)

Evidence: `.harness/ui-pass-final-20260909/` in the UI worktree. All
captures are of live fixture data on the isolated preview; draft states
were created as visitor-scoped saved work only, nothing recorded.

- `proto-b-1440.png` — the approved prototype, freshly rendered.
- `od2002-initial-1440.png` / `-390.png` / `-text200.png` — the proposed
  reading: prose Fit/Risk enumerations with inline highlighted claims,
  "(proposed)" markers, severity chips with rule-code cues, priority
  lines, hold sentence with disabled Complete review. Horizontal
  overflow 0 at 1440, 390, and 200% text; no page errors.
- `od2002-fit-open-1440.png`, `od2002-risk-open-1440.png` — the
  evidence-and-judgment panels: excerpt, rule title and text, stated
  rationale, named-outcome verbs, reason field, per-claim ask.
- `od2002-drafts-1440.png` — draft markers in outcome colours:
  "(draft — fits this need)" green, "(draft — ruled out)" red,
  "(AI-01 · draft — more information needed)" amber, a factor line
  "(draft — record 120 requests per month)", and the hold sentence
  recomputed live from the drafts.
- `od1025-hold-1440.png`, `od1025-reveal-1440.png` — the Actions hold
  with the empty-fit affirmation, then the earned reveal: routing
  fields and rating radios appear only after the drafts clear the hold.
- `od1028-completed-1440.png` (+`-390`) — recorded markers, coverage-led
  fit claims, rule-title risk conditions, "Recorded: confirmed · Decided
  by …" in the panel, supplied-by/recorded-by attribution on priority
  lines, the done box.
- `od2001-priority-1440.png` — an open rice question on its factor line.
- `od2005-closed-1440.png` — closed-without-review Actions statement.
- `od1029-resolved-1440.png` — resolved read-only with the recorded
  verdict still readable.
- `od2002-catalogue-1440.png` — the in-place catalogue swap. This
  capture shows the one defect the pass found: USWDS floats
  `[type=search]` left, pulling the first result beside the box. Fixed
  in b0730ab (plain text input); the fix is committed but not in the
  captured build.

**Verdict:** the rendered page matches the approved prototype's
interaction model — prose claims, one panel per click, compact priority
lines, single Actions block with hold sentence and one Complete review
button, the Prepared assessment heading with the request title as
context. Differences that stand and are intentional: real workflow
surfaces the prototype lacked (Preparation/staleness notices, service
suggestions between Fit and Risk, questions, Save progress, the
coordination disclosure); multi-line claims render as wrapped
highlighted blocks because real claim text is longer than the
prototype's one-liners — the same mechanics the prototype's own
inline-block buttons produce.

**Idle save-status line:** the finish form's idle line read "No draft
changes yet" even when claim drafts existed — a contradictory status,
not cosmetic. Fixed in 36c5781 (idle kind suppressed in both Actions
forms) and verified absent on build-v4 with a standing claim draft
(`.harness/ui-audit-v4-20260909/v4-drafts-actions-1440.png`).

**Human design gate: pending.** No person has reviewed the rendered
final page yet; root's rendered check and these captures are agent
evidence only.

Measured values in the historical sections below come from a
computed-style probe on OD-1001 at 1440px on the superseded build
(`.harness/ui-pass-20260909/measure.mjs`).

## Legend

- pass — verified on the rendered page, with the evidence named.
- fail — verified defect; fixes noted inline.
- n/a — rule cannot apply, with the reason.
- not verified — no evidence either way in this pass; open work, not a pass.

## Historical rule inventory — build-v4 (2026-09-09)

Each rule below records the verdict for the approved prose page at that time,
measured on build-v4 (buildId h9hr8xZB6NYcvXdHJ89_8, both 4197 and
4188). Evidence: computed-style probe and captures in
`.harness/ui-audit-v4-20260909/` (probe.mjs output quoted inline;
v4-initial/drafts/catalogue captures; aria-assessment-closed/-risk-open
snapshots), the build-v3 state captures in
`.harness/ui-pass-final-20260909/` for surfaces byte-identical between
v3 and v4 (everything except the catalogue input and the Actions idle
line), source files, and the green unit/browser suites on the final
build. Shared controls unchanged since the earlier audit cite that
audit's still-applicable checks by name.

### Purpose, order, and comprehension

- Task clarity: **pass** — context line, "Prepared assessment" h1, stage
  line, and the section order state the job at once (v4-initial-1440).
- Clear primary action: **pass** — one filled "Complete review" button;
  the hold sentence names what stands in its way (od1025-hold/reveal).
- Natural task flow: **pass** — said → fit → risk → priority → actions,
  the approved prototype's order.
- One primary answer per question: **pass** — one open panel at a time,
  one judgment per claim, one score line, one Actions block.
- Essential controls only: **pass** — every control records a judgment,
  files a question, searches the catalogue, or completes.
- Aesthetic and minimalist design: **pass** — the design-explanation
  copy was cut in 64b4e90; remaining secondary text is provenance and
  guidance inside opened editors.
- Optimize comprehension, not click count: **pass** — the resting page
  is a readable brief; clicks open evidence, never empty steps.

### Convention, consistency, and defaults

- Consistency and standards: **pass** — USWDS controls, native
  details/summary for the remaining quiet disclosures (coordination,
  catalogue results, History's original description), standard
  breadcrumbs; asks and early close became deliberate linkish actions
  in the boundary reduction.
- Internal consistency: **pass** — one marker vocabulary: italic worded
  state in parentheses on claims, factor lines, and the hold sentence;
  severity has its own chip scale.
- Native semantics first: **pass** — buttons for claims (aria-expanded),
  native select/textarea/radio/checkbox, section/h2 landmarks
  (aria-assessment-closed.txt).
- Safe defaults: **pass** — everything is a draft until an explicit
  save; "No change this submission" remains each factor's default.
- Match between system and real world: **pass** — "Fits this need",
  "Rule out this option", "Finding does not apply", "working days".
- Recognition rather than recall: **pass** — recorded outcomes, drafts,
  and question states read inline in the prose markers.

### Hierarchy and emphasis

- Clear visual hierarchy: **pass** — h1 32px/700, section h2 24px/700
  navy #162e51, body ~17px, markers 14.1px italic #555 (probe).
- Use multiple hierarchy cues: **pass** — position, size, weight,
  highlight background, and tone colour combine on claims.
- De-emphasize secondary content: **pass** — provenance and markers at
  13.9–14.1px in greys.
- Contrast follows importance: **pass** — content #1b1b1b; the claim
  highlight #eef4f9 with a #005ea2 underline carries the affordance.
- Action hierarchy matches consequence: **pass** — Save progress
  (outline) beside Complete review (filled), both at the end.
- Destructive-action hierarchy: **n/a** — no destructive action.
- Stable font weight across states: **pass** — markers change colour and
  words, never weight (od2002-drafts-1440).
- Displayed-data labels earn their place: **pass** — estimates read as
  sentences ("6 person-months (120 working days)", od1028-completed).

### Grouping and space

- Gestalt proximity: **pass** — markers ride their claims; attribution
  rides its factor line; panel content sits under its paragraph.
- No horizontal rules: **pass** — no border-top dividers; the panel is a
  bounded box, the excerpt a left-edge quote bar.
- Whitespace before other dividers: **pass** — sections separate by
  space and headings alone.
- Content-driven width: **pass** — the reading column is 736px (46rem),
  the approved prototype's own canvas measure; nothing stretches.

### Measurement and repeated roles

- Spacing and sizing scale: **pass** — module uses the rem scale
  (0.25/0.5/0.75/1/2/3rem in review-brief.module.css).
- Design tokens: **pass** — USWDS palette plus the prototype's tokens
  (#162e51, #005ea2, #eef4f9, #f7fbff, #a5c9e5).
- Visual-role consistency: **pass** — every claim shares one highlight
  geometry; every marker one style; every panel one box.
- Limited visual roles: **pass** — body, h2, claim highlight, marker,
  chip, provenance; the role count stayed small.
- Bounded fluid sizing: **n/a** — no fluid-sized element.
- Scale component properties independently: **pass** — chips scale text
  and padding separately from the prose.
- Intentional visual decisions: **pass** — each border names a boundary:
  panel box, excerpt bar, claim underline, severity chip edge.

### Typography

- Readable body-text size: **pass** — 16.96px (probe).
- Touch input text size: **pass** — inputs inherit ≥16px.
- Readable measure: **pass** — 736px column ≈ 85 characters at body
  size; within the 90-character ceiling and exactly the approved
  prototype's 46rem measure.
- Minimum line height: **pass** — prose 27.1px/16.96px = 1.6 (probe).
- Responsive line height: **pass** — markers and provenance carry more
  relative leading than headings.
- Tracking follows size and case: **pass** — no uppercase runs.
- Limit emphasized passages: **pass** — bold marks option names,
  factor names, and recorded verdicts only.
- Limited type palette: **pass** — one family (Public Sans stack).
- Readable font weights: **pass** — 400 body, 700 headings.
- Left-align running text: **pass**.
- Typographic baseline alignment: **pass** — markers and chips share the
  sentence baseline (v4-initial-1440; wrapped claims keep line rhythm).
- Tabular figures: **pass** — unchanged shared table styling
  (app.css:177 and module files, read in source; the brief itself has
  no shifting counters).
- Purposeful typeface selection: **pass** — the product's civic-service
  face, unchanged.

### Colour and contrast

- Avoid absolute black and white: **pass** — #1b1b1b on #f7f9fa.
- Coherent neutral palette: **pass** — one cool grey family.
- Luminance separates palette roles: **pass** — highlight, panel, and
  page backgrounds step by lightness.
- Defined colour ramps: **pass** — USWDS ramps.
- Single primary accent: **pass** — one blue (#005ea2) for links, claim
  underlines, and primary buttons.
- Do not rely on colour alone: **pass** — every marker carries its words
  ("draft — ruled out"); severity chips carry their word; the rule code
  rides the marker.
- Contrast hierarchy: **pass**.
- Text contrast: **pass** — body ≈15:1; markers #555 ≈ 6.9:1 at 14px;
  severity chips: high #8b0a03/#f8dfe2 ≈ 8:1, moderate #775540/#faf3d1
  ≈ 5.6:1, unknown #3d4551/#f0f0f0 ≈ 9:1, critical white/#8b0a03 ≈ 8.6:1
  (probe colours, ratios computed).

### Lines, borders, boxes, and depth

- Purposeful boundaries: **pass** — claim underline (affordance), panel
  box (opened evidence), excerpt bar (quoted source), chip edge.
- One visual separator per boundary: **pass** — panels separate by box
  alone; sections by space and headings alone.
- Use borders sparingly: **pass** — the resting page shows only claim
  underlines and form-field borders.
- Border contrast: **pass** — #a5c9e5 panel edge on #f7fbff/#f7f9fa
  reads as one boundary.
- No stacked hard separators: **pass**.
- Consistent elevation system: **pass** — flat; no shadows.
- Consistent light source / shadow ratio / dark depth / concentric
  radii: **n/a** — no shadows, dark surfaces, or nested radii.
- Supporting-icon contrast: **n/a** — no icons beside text; disclosure
  markers are the platform's.

### Alignment, indents, and layout

- Alignment discipline: **pass** — one content edge; panels and slots
  share it (v4-initial-1440).
- Comparable numbers align alike: **pass** — estimates render inline in
  sentences in draft and recorded states alike.
- Semantic indentation: **pass** — the excerpt bar indents quoted
  evidence; nothing else indents.
- Optical alignment: **pass** — no asymmetric shapes needing correction.
- Twelve-column grid: **n/a** — single-column reading page.
- Columnar layout over stretching: **pass** — one 46rem column.
- Content-sized regions: **pass** — the brief caps at 46rem; the need
  lead keeps its measure inside it.
- Centered readable measure: **pass**.
- Mobile-first supported layout: **pass** — 390px renders one clean
  column, overflow 0 (od2002-initial-390, od1028-completed-390).

### Horizontal width and tables

- Document width containment: **pass** — sideways scroll 0px at 1440,
  390, and 200% text (measured in the final pass, unchanged in v4).
- Content reflow: **pass** — wrapped claims keep whole tokens at 390px.
- Frozen row/column context, overflow cues: **n/a** — no table on the
  brief; the queue keeps its own acceptance coverage.

### Controls and forms

- Persistent visible labels: **pass** — every input labelled; claim
  buttons are their own text.
- Field meaning and consequences: **pass** — effort names its unit and
  storage in its hint; reason labels name their requirement ("Why it is
  ruled out").
- Top-aligned field labels: **pass**.
- Placeholder text is supplementary: **pass** — no placeholders.
- Field width signals expected input: **pass** — numeric fields keep
  usa-input--medium and per-factor inputmode (unchanged since the
  earlier fix; FactorEditor source and reviewer-interactions suite).
- Use textareas for multiline input: **pass**.
- Concise hint text: **pass**.
- Programmatic descriptions: **pass** — Field wires aria-describedby
  (src/ui/fields.tsx, unchanged).
- Native input attributes: **pass** — inputmode/pattern on reach
  (whole-count suite green on the final build).
- Labels and adornments focus the field: **pass** — native label/for.
- Implicit form submission: **n/a by design** — draft surface with
  multiple buttons.
- Prevent duplicate submission: **pass** — buttons disable while
  pending; the idempotency key and attempt-id invariants pin replays
  (unit suite; root's contributions tests on the final build).
- Immediate toggle response: **pass** — verbs set the draft on click;
  the marker updates in the same commit (od2002-drafts-1440).
- Visible affordances: **pass** — claims are highlighted and underlined
  with pointer cursor; the context line says to click them.
- Outcome-oriented control labels: **pass** — every verb names its
  outcome; "Complete review", "Save progress", "File the question".
- Controls near their scope: **pass** — judgment verbs live in the
  claim's panel; Edit on its factor line.
- Action consequences stay visible: **pass** — the hold sentence sits
  beside the disabled button; "Everything saves together…" appears with
  the revealed completion fields.
- Button padding ratio: **pass** — USWDS buttons unchanged.
- Minimum target size: **fail → fixed** — the rule carries no
  inline-text exemption (the earlier exemption claim here was wrong).
  The Edit control measured 30.2×16.6px on the v4 touch probe (root's
  touch-probe.json; reproduced 16.56px in the new regression). A first
  fix used negative-margin hit expansion; root's overlap probe showed
  adjacent factor targets overlapping 23×14px with elementFromPoint
  crossing rows (touch-overlap-probe.json), so the fix is normal flow
  instead: linkish controls carry block padding to ≥24px on any
  pointer, and under (pointer: coarse) every brief control meets 44px in
  both dimensions — buttons and linkish controls as 44×44 minimum boxes,
  claims padded to ≥44px lines, all summaries at ≥44px rows (root's
  brief-touch-control-sizes.json measured Read-full-request/Ask
  summaries at 38px, USWDS buttons at 39.3px, ask summaries at 27.8px on
  v4), inputs and selects at 44px, and the rating labels as 44×44 flex
  targets while the native glyphs stay small — no negative margins
  anywhere, so targets cannot overlap by construction. Verified
  rendered on build-v5: the touch regression passes against the served
  build (both dimensions ≥44 on the Reach and Impact Edits, disjoint
  boxes, edge hits resolving to their own factor, summary and
  Save-progress sizes, claim separation), and the label probe measured
  the affirmation label at 340.6×44 and each rating label at 55.4×48
  with no overlaps (`.harness/ui-audit-v4-20260909/v5-labels.mjs`,
  v5-touch-reveal-390.png). Touch rows sit taller; desktop rows may
  grow a few pixels where the 24px box exceeds the old line height.
  The boundary reduction then added navigation anchors outside the
  brief module (the History link, the section returns, the done-box
  Open Delivery link); the v6 rendered audit measured them under 44px
  on a coarse pointer, fixed in app.css with the same normal-flow
  approach plus a regression in the interactions suite, and served
  build-v7 measures all six new controls at or above 44px in both
  dimensions (`.harness/ui-audit-v7-20260909/touch-v7.txt`).
- Minimum target separation: **pass** — estlines at 8px margins with
  inline links separated by text; claims separated by line height.

### System state and feedback

- Visibility of system status: **pass** — the boundary line shows
  loading or a named failure with reload; sends announce in
  #confirmation; the idle "No draft changes yet" no longer renders in
  Actions (36c5781; verified absent with a standing draft on v4,
  v4-drafts-actions-1440).
- Contextual feedback: **pass** — precision errors under their field;
  owner load failures beside their claim/factor (SavedWorkProblem).
- Visual stability across states: **pass** — the hold sentence swaps for
  the completion fields in place (od1025-hold → od1025-reveal).
- Actionable empty state: **pass** — zero candidates renders the
  affirmation sentence and checkbox (od1025-hold-1440).
- Disclosures are a last resort: **pass by approved design** — the
  panel-per-claim model is the approved prototype's own paradigm; the
  resting page carries every state in its markers. The boundary
  reduction removed the standing ask and early-close disclosures in
  favour of deliberate actions, and moved History and Delivery off the
  peer tab strip to on-demand entry.
- Disclosure signifiers: **pass** — quiet disclosures name their
  content; claims state the claim itself.
- Complete revealed states: **pass** — panels render in flow below the
  paragraph; nothing overlays.

### Errors, safety, and recovery

- Error prevention: **pass** — reject requires its reason; override its
  severity; incomplete drafts hold completion with the count
  (completionHold; unit pins).
- Deferred field validation: **pass** — unchanged entry logic.
- Inline and summary error messages: **pass** — rating error inline and
  in RatingErrorSummary, unchanged.
- Persistent error messages: **pass** — precision text stays until the
  value changes.
- Preserve input on error: **pass** — drafts survive failed sends and
  reloads (suites; recovered-work lifecycle unchanged).
- Redundant error cues: **pass**.
- Field-identifying error copy: **pass** — unchanged texts.
- Specific error messages: **pass** — junk, range, precision distinct.
- Plain-language error messages: **pass**.
- System failures use page-level errors: **pass** — record load failure
  keeps the Problem alert; a draft owner's failed WIP load now renders
  its own message with a reload control (9900c71).
- Repeated-error threshold: **proxy observed only** — unchanged claim;
  needs usage observation.
- User control and freedom: **pass** — "Set the draft back" on claims;
  "No change this submission" on factors.
- Recoverable destructive actions: **n/a**.
- State persistence across interruption: **pass** — drafts persisted
  through reloads and the catalogue swap (hidden, not unmounted).
- Confirm only irreversible actions: **pass** — completion is one
  explicit action.

### Motion and response time

- Direct-manipulation response time: **pass** — markers and holds update
  in the same render as the click.
- Flow-preserving response time: **pass** — no progress theatre.
- Progress feedback after one second: **pass** — pending buttons
  disable; "Loading saved work…" covers slow owner loads.
- Interruptible long-running work: **n/a** — none on the brief.
- Short interaction animation / scale animation / decorative motion /
  offscreen animation: **pass / n/a / pass / n/a** — no animation
  beyond native disclosure.
- Doherty threshold: **pass**.

### Real content and supported conditions

- Design with representative data: **pass** — audited on live fixtures:
  dense OD-2002 (3 candidates, 8 findings), empty-fit OD-1025,
  question-bearing OD-2001, completed OD-1028, closed OD-2005, resolved
  OD-1029.
- Text resize to 200%: **pass** — overflow 0, clean reflow
  (od2002-initial-text200).
- Preserve text tokens: **pass** — long rule titles stay whole at 390px.
- User images / text over images / image integrity: **n/a**.
- No sticky hover on touch: **fail → fixed** — root's v4 probe showed a
  tap retaining the claim hover shade (238,244,249 → 217,232,246) and
  the Edit hover colour until tapping elsewhere. The hover rules for
  .claimtxt and .linkish now gate behind (hover: hover); the touch
  regression asserts resting colours survive a tap, and it passes
  against served build-v5.
- No obstructive autofocus on touch: **pass** — nothing autofocuses.

### Accessibility and keyboard use

- Full keyboard operability: **pass via the focus suite** — the
  rewritten focus acceptance tests, including the completion-radio
  probe, pass on the final build (root's runs; focus-proof.log).
- Visible keyboard focus: **pass via the same suite**.
- Programmatic accessible names: **pass** — claims are named buttons
  with aria-expanded; sections are landmarks with headings
  (aria-assessment-closed.txt).
- Disabled controls do not own essential help: **pass** — the hold
  sentence, not the disabled button, carries the reasons.
- Non-interactive tooltips: **n/a**.
- Accessibility-tree parity: **pass** — fresh aria snapshots of the
  prose page, closed and with a risk panel open
  (aria-assessment-closed.txt, aria-assessment-risk-open.txt): headings
  in reading order, claim buttons named by their claim text, panel
  content present only while open, form controls named.
- Programmatic state announcements: **pass** — role=status boundary
  line, role=alert failures, #confirmation live region.

### Final inspection

- Whole-page composition: **pass** — the resting capture reads as the
  approved brief: said, fit, risk, priority, actions
  (v4-initial-1440 beside proto-b-1440).
- Visual-device audit: **pass** — each device named above serves a
  boundary or an affordance.
- Repeated-relationship audit: **pass** — claims, markers, chips, and
  estlines repeat exactly.
- Interactive-state audit: **pass for the states exercised** — proposed,
  draft, waiting-question, hold, reveal, completed, closed, resolved,
  catalogue swap; hover states beyond the claim shade not audited.

## Historical follow-up record

1. Both v4-verification targets pass on the served build: the first
   visible catalogue result starts below the search input (input bottom
   243.8 < result top 255.8), and Actions shows no "No draft changes
   yet" while a claim draft stands (`.harness/ui-audit-v4-20260909/`,
   verify.mjs output).
2. Sticky hover and target size were demonstrated failures on v4;
   both are fixed and verified rendered on build-v5 (regression green
   against the served build; label probe above). The repeated-error
   threshold genuinely needs people and stays with the human review —
   not claimed.
3. Visual parity: the boundary reduction changed exactly the
   assessment, delivery, and history screens. Those six baselines
   (desktop and text200) were re-minted from served build-v7 on 4188
   with a same-day fixture and verified by a full zero-diff rerun
   (6/6 tests, 50 screenshot comparisons, maxDiffPixels 0). The
   other 44 comparisons passed unchanged in the pre-mint diff run.
   Historical baseline files outside the current suite are retained
   but are not covered by this verdict.
4. Human design gate: pending a person's review of the rendered page.

## Compatibility disclosure (walked)

The "Earlier saved priority form" disclosure was owner-proven rendered on
the compat build (2026-09-09, `.harness/ui-pass-20260909c/compat-owner.png`):
signed as the legacy rice row's owner, the priority section shows the
closed disclosure; expanded, it renders the row's saved reach value with
the reference-only copy. A different visitor sees no disclosure. Every
non-GET request was armed to abort and none was attempted. One data note:
both the live and native rows hold reach "0" (verified equal); the
disclosure renders whatever the owner saved. The zero-diff parity rerun
stayed green — the parity fixture has no rice draft, so no captured
screen changes and no baseline update is warranted.

## Historical rendered follow-up

The audit ran against the build of commit 365dfba plus the fixes noted
inline. Later commits added rendered states, each since walked on the
final builds (2026-09-09, `.harness/ui-pass-20260909b/` and `…c/`):

- Recorded-by attribution: **walked** — OD-1003 renders "supplied by Devon
  Okafor · recorded by Desmond Arkwright"; the adopted case shows no
  recorded-by clause.
- Claim ask forms: **walked** — fit and risk claims render the form with no
  factor picker; a risk question filed, answered, and shown with truthful
  attribution; clean at 390px.
- Whole-count reach: **walked** — numeric inputmode, digit pattern, junk
  fills rejected, ArrowUp inert.
- Closed-request read-only: **walked** on OD-1029 (zero editing, asking,
  answering, saving controls). Resolved-before-review: **walked** — OD-2005
  (submitted, never reviewed) withdrawn through the ordinary delivery
  outcome form (closed_without_fulfillment); the assessment renders
  "Request closed without first review" with zero editing, asking,
  answering, or saving controls and the evidence read-only
  (`.harness/ui-pass-20260909c/c-closed-without-review.png`). The record
  was an existing visitor-created request (no fixture key: its record-meta
  carries no "Seeded example" and its requester is a visitor actor), not a
  seeded fixture, because intake creation needs the model worker the
  preview does not run. The demo restore intentionally preserves
  visitor-created records, so the withdrawal cannot be undone by a
  fixture reset; database backups remain the recovery route.
- Allocation-pending line and addressee-only gate: **walked** — unassigned
  question shows the line and no form; the admin route shows the assign
  control.
- The update-answer form: **walked** — renders on the answered question,
  prefilled with the earlier reply (f2/f3 captures). The walk found two
  gate defects on the way: state "answered" blocked the form (fixed,
  8d1fa4e, verified rendering live) and the stored response id was reused
  on the second send, rejected by the backend's reuse guard as a version
  conflict (fixed, 2c20fa3). The UI-button unknown→provided walk then
  completed end to end on the merged build (two responses retained,
  latest provided, updated answer rendered), and the full browser suite
  (59/59) exercised the same-question loop.
- The requester invitation with no required attributes (54ce5db) —
  covered by the full browser run (59/59 with the stub worker): every
  intake submission asserts the invitation is present and closed before
  Send request.
- Boundary reduction (no peer tab strip, History as quiet reference,
  delivery on demand, early close, compact need facts, asks as
  deliberate actions): **walked on build-v7** (2026-09-09, evidence in
  `.harness/ui-audit-v7-20260909/`: audit-v7.txt, reprobe-v7.txt,
  touch-v7.txt, gate-401-v7.txt, v7-*.png). The open review shows one
  History link and zero standing "Next:" links; History renders as a
  reference whose return link names its origin ("← Back to the
  assessment" / "← Back to the delivery view"); a deep-linked delivery
  view during an open review renders exactly one back link
  (reprobe-v7.txt — the wait-free probe's zero is its known timing
  bug). The confirmed facts render single-column (factColumns 1, zero
  details inside #need) with all four fact groups (What success looks
  like, What it needs to do, Limits to work within, Questions still to
  resolve); the transcript lives in History's "Original description"
  details. The resting page shows zero standing factor asks; the ask
  renders only inside the opened factor editor. Early close renders as
  one linkish trigger on the open assessment; root's boundary suite
  walks closed_without_fulfillment end to end. Overflow 0 at 1440,
  390, and 200% text. The unauthenticated gate's one console 401 is
  /api/metadata refusing a session-less fetch before code entry
  (gate-401-v7.txt) — pre-authentication behaviour, not a brief
  surface.
