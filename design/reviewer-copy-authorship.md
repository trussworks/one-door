# Reviewer copy authorship

Maz requested independent redrafting on September 9, 2026. The reviewer page
keeps the approved prose layout and existing workflow.

A fresh Codex context received workflow facts, available actions, state
conditions, placeholders, and the layout without its text. The writer received
no prior interface wording, source files, tests, prototypes, screenshots, or
conversation history. Codex supplied additional factual requirements where
coverage or contract checks found gaps. The first draft and every revision remain
preserved.

Codex authored the copy. Codex and Claude integrated the supplied strings;
Claude's role was technical implementation and factual critique. The standing
ownership rule is recorded in `REPO_RULES.md`.

## Scope

The replacement covers the review brief, catalogue discovery, priority
contributions and questions, review responsibilities, request history, delivery,
the review queue, related requester-estimate and administrator-note controls,
and shared navigation, ratings, errors, and draft recovery messages. Earlier
estimate and question drafts retain their recovery paths.

Stored requester content, human explanations, catalogue descriptions, policy
sources, and model results retain their content and attribution. Internal
identifiers, native browser messages, and library text are not rewritten.
Unrouted legacy review editors and unrelated intake or administration screens
are outside this correction. Shared controls used by those screens receive the
same corrected shared messages.

The implementation keeps copy beside the controls that use it. There is no new
translation or copy-rendering framework. Questions still use their existing
commands; review decisions still use the atomic submission. The presentation
checks now distinguish unavailable priority data from pending estimates, retain
the explanation in an unknown answer, and declare optional question fields
according to the existing contract. Collapsed estimate drafts retain their
intended action and changed value.

## Evidence

The retained evidence directory is `.harness/reviewer-copy-20260909/`.
`authorship-record.json` identifies the author, inputs, preserved first draft,
final draft, and their SHA-256 hashes. The independent draft contains 699 strings,
including variants that do not require additional interface elements.
`root-coverage.json` and the peer coverage artifact named in the authorship record
map strings to their integration sites.

The original page capture is `before-1440.png`; its receipt records a 1440-pixel
viewport and zero attempted writes. Validation and final captures are recorded
in the same evidence directory. Human review of the rendered correction remains
pending with Maz.

## Validation

Build-v12 passed all 69 browser scenarios and all 50 executed visual
comparisons. Unit, backend, infrastructure, container, and worker-shutdown
checks are recorded with the retained validation receipts. The copy correction
keeps the existing workflow, including partial priority contributions,
question updates, atomic review recording, stale-draft recovery, and
completion with priority pending.

Responsive checks also found and corrected narrow-screen overflow and
undersized shared touch controls. The score-history table uses the existing
accessible scroll component. The final evidence and the bounds of the
rendered checks are recorded in `reviewer-brief-rules-record.md`.

Two local validation database passwords were printed in the peer's transcript
during inspection. Both passwords were rotated; new credentials connected
and old credentials were refused. Live demo credentials were not included.
The transcript and validation databases remain retained; no database contents
were removed as part of the rotation.
