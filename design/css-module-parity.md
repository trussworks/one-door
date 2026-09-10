# CSS-module comparison

Navigation annotation: September 7, 2026. Original document date not recorded. This record owns the corrected doubled-text evidence referenced by the earlier workflow and understandability audits. Reproduction still requires a fresh baseline.

The final conversion was compared with a separate production build at `37216c2`, using the same isolated PostgreSQL fixture and saved browser sessions. That baseline already contained Claude's first eleven converted components; the combined app now uses twenty CSS modules. Shared application/control foundations remain global.

## Evidence

The suite captures **68 states**: 34 at normal text size and the same 34 with doubled browser-default text. The captures include the gate, landing page, queues, record sections, inventory, reports, saved requester questions/refinement/strong-fit/waiting states, and every RICE step plus its final actions.

[Test fixture preparation](../test/visual-fixture.ts) runs the normal application workflows with a controlled provider, then stops that worker before either comparison. No requests are submitted or rated by fixture preparation. The queued waiting case intentionally stays queued. Model counters, saved values and request contents therefore do not drift between builds.

[The comparison suite](../test/visual-parity.acceptance.ts) retains full-screen screenshots; it does not replace RICE, requester or report captures with style-only checks. Only native progress animation is masked, with separate visibility/color checks. Font size and `em` media queries are asserted before and after every capture. Chrome launches with fixed renderer defaults, so screenshot capture cannot silently turn the 200% test back into ordinary text.

The final eight tests passed. The pixel tolerance remains zero. One desktop queue underline endpoint differed by one comparator-reported pixel and was accepted under Maz's explicit allowance for very minor differences. Its [before](screenshots/css-modules/final-queue-before.png) and [after](screenshots/css-modules/final-queue-after.png) are retained; the accepted image is the regression reference. An earlier diagnostic also compared all 324 rendered header/sidebar/main elements on the queue and found identical bounds, text and measured font/spacing/color properties.

## What the comparison caught

The stable fixture exposed genuine cascade differences: global heading defaults overrode local component headings, and the USWDS fieldset reset removed RICE spacing. The shared heading selector and the RICE fieldset modifier now express the intended precedence independent of chunk order. The send-section spacing explicitly retains its prior rendered value. No large layout shift was accepted as data drift.

## Reproduction limits

The goldens record this fixture, date, Chrome renderer and macOS fonts. Prepare an unchanged baseline before a new visual comparison; do not update goldens from a failing changed build. [Development instructions](../DEVELOPMENT.md#visual-comparisons) describe the two-build process.

Earlier screenshots made with temporary DevTools font overrides are not the final enlarged-text evidence. The new `*-text200-darwin.png` references are. Human design approval and actual screen-reader speech testing remain outside this automated comparison.
