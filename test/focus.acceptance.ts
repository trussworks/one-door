import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

let sessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>>;

// One gate login for the whole file; repeated logins trip the demo throttle.
test.beforeAll(async ({ browser }, info) => {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/review");
    await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
    await page.getByRole("button", { name: "Enter demo", exact: true }).click();
    await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
    sessionCookies = await context.cookies();
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(sessionCookies);
});

async function enter(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
}

// Chrome sends Secure cookies on loopback HTTP; Playwright's request client does not.
async function browserRead(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(path + " returned " + response.status);
    return response.json();
  }, path);
}

interface FocusState {
  keyboard: boolean;
  outlined: boolean;
  blue: boolean;
  indicated: boolean;
  outlineLuminance: number | null;
  surfaceLuminance: number | null;
  borderVisible: boolean;
}

async function focusState(
  page: Page,
  baseline?: { borderColor: string; boxShadow: string },
): Promise<FocusState | null> {
  return page.evaluate((baseline) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const parse = (color: string) => {
      const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    };
    const luminance = (color: string) => {
      const rgb = parse(color);
      if (!rgb) return null;
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const blueFamily = (color: string) => {
      const rgb = parse(color);
      if (!rgb) return false;
      const [r, g, b] = rgb;
      return b >= 120 && b - r >= 40 && b - g >= 30;
    };
    const transparent = (color: string) => /rgba\([^)]*,\s*0\)$/.test(color);
    const visibleOutline = (element: Element, pseudo?: string) => {
      const style = getComputedStyle(element, pseudo);
      if (style.outlineStyle === "none") return null;
      if (parseFloat(style.outlineWidth) <= 0) return null;
      if (transparent(style.outlineColor)) return null;
      return style.outlineColor;
    };
    const outlineFor = (element: Element) => {
      const outline = visibleOutline(element);
      const id = element.getAttribute("id");
      if (outline || !id) return outline;
      // USWDS paints checkbox/radio focus on the label, not the input.
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      return label ? visibleOutline(label, "::before") : null;
    };
    const surfaceColor = (element: Element) => {
      let surface = element.parentElement;
      while (surface) {
        const background = getComputedStyle(surface).backgroundColor;
        if (background && !transparent(background)) return background;
        surface = surface.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    const fieldState = (element: Element) => {
      const style = getComputedStyle(element);
      const borderChanged = baseline
        ? baseline.borderColor !== style.borderColor ||
          baseline.boxShadow !== style.boxShadow
        : false;
      const shadowColor = style.boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? "";
      return {
        borderChanged,
        blue:
          borderChanged && [shadowColor, style.borderColor].some(blueFamily),
        borderVisible: parseFloat(style.borderBottomWidth) > 0,
      };
    };
    const outlineColor = outlineFor(active);
    const field = fieldState(active);
    return {
      keyboard: active.matches(":focus-visible"),
      outlined: outlineColor !== null,
      blue: blueFamily(outlineColor ?? "") || field.blue,
      indicated: outlineColor !== null || field.borderChanged,
      outlineLuminance: luminance(outlineColor ?? ""),
      surfaceLuminance: luminance(surfaceColor(active)),
      borderVisible: field.borderVisible,
    };
  }, baseline);
}

async function captureBaseline(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
}

async function expectPointerQuiet(page: Page, target: Locator, name: string) {
  await target.click();
  await page.waitForTimeout(150);
  const state = await focusState(page);
  if (!state) return;
  expect(state.blue, `${name}: no blue indicator in any modality`).toBe(false);
  if (!state.keyboard)
    expect(state.outlined, `${name}: pointer click must not outline`).toBe(
      false,
    );
}

async function expectFieldFocus(page: Page, target: Locator, name: string) {
  const baseline = await captureBaseline(target);
  await target.click();
  await page.waitForTimeout(150);
  const state = await focusState(page, baseline);
  expect(state, `${name}: the field takes focus`).not.toBeNull();
  expect(state!.blue, `${name}: the field indicator must not be blue`).toBe(
    false,
  );
  expect(
    state!.indicated,
    `${name}: an active field needs a visible indicator`,
  ).toBe(true);
  expect(state!.borderVisible, `${name}: the field keeps its border`).toBe(
    true,
  );
  await expect(target).toHaveCSS("border-color", baseline.borderColor);
  if (await target.evaluate((element) => element.tagName === "SELECT"))
    await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  const keyed = await focusState(page, baseline);
  expect(keyed?.indicated, `${name}: keyboard focus stays visible`).toBe(true);
  expect(keyed?.blue, `${name}: keyboard focus must not be blue`).toBe(false);
  await expect(target).toBeFocused();
}

async function expectKeyboardOutline(
  page: Page,
  name: string,
  surface?: "light" | "dark",
) {
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  const state = await focusState(page);
  expect(state, `${name}: Tab must land on a control`).not.toBeNull();
  expect(state!.indicated, `${name}: keyboard focus must be visible`).toBe(
    true,
  );
  expect(state!.blue, `${name}: keyboard outline must not be blue`).toBe(false);
  if (surface && state!.outlineLuminance !== null) {
    const high = Math.max(state!.outlineLuminance, state!.surfaceLuminance!);
    const low = Math.min(state!.outlineLuminance, state!.surfaceLuminance!);
    expect(
      (high + 0.05) / (low + 0.05),
      `${name}: focus contrast`,
    ).toBeGreaterThanOrEqual(3);
    if (surface === "dark")
      expect(
        state!.outlineLuminance,
        `${name}: a dark surface needs a light outline`,
      ).toBeGreaterThan(state!.surfaceLuminance ?? 0);
    else
      expect(
        state!.outlineLuminance,
        `${name}: a light surface needs a dark outline`,
      ).toBeLessThan(state!.surfaceLuminance ?? 1);
  }
}

async function probe(
  page: Page,
  target: Locator,
  name: string,
  surface?: "light" | "dark",
) {
  const labelFor = await target.getAttribute("for");
  const control = labelFor ? page.locator(`[id="${labelFor}"]`) : target;
  await expectPointerQuiet(page, target, name);
  await expectKeyboardOutline(page, name, surface);
  await expect(control).toBeFocused();
}

test("the administrator note textarea focuses visibly without any blue ring", async ({
  page,
}) => {
  await enter(page, "/admin/requests");
  await page.locator('tbody a[href*="/admin/requests/"]').first().click();
  await page
    .getByRole("link", { name: "Request history", exact: true })
    .click();
  await expect(page.locator("#history")).toBeVisible();
  const note = page.getByLabel("New administrator note");
  await expect(note).toBeVisible();
  await expectFieldFocus(page, note, "administrator note textarea");
});

test("focusing an invalid note preserves its error and field border", async ({
  page,
}) => {
  await enter(page, "/admin/requests");
  await page.locator('tbody a[href*="/admin/requests/"]').first().click();
  await page
    .getByRole("link", { name: "Request history", exact: true })
    .click();
  await expect(page.locator("#history")).toBeVisible();
  const note = page.getByLabel("New administrator note", { exact: true });
  await note.fill("   ");
  await page.getByRole("button", { name: "Record note", exact: true }).click();
  const error = page.getByText("Enter a note before saving.", {
    exact: true,
  });
  await expect(error).toBeVisible();
  await expect(note).toHaveAttribute("aria-invalid", "true");
  await expectFieldFocus(page, note, "invalid note");
  await expect(error).toBeVisible();
  await expect(note).toHaveAttribute("aria-invalid", "true");
});

test("dashboard metric links stay quiet on click and mark keyboard focus without blue", async ({
  page,
}) => {
  await enter(page, "/dashboard");
  // The metric link's accessible name carries its count, so match by text.
  const resolved = page.locator("a", { hasText: "Resolved" }).first();
  await probe(page, resolved, "Resolved metric link", "light");
  const row = resolved.locator("xpath=..").locator("xpath=..");
  const metricLinks = row.locator("a");
  expect(
    await metricLinks.count(),
    "dashboard exposes metric links",
  ).toBeGreaterThan(1);
  await expectPointerQuiet(page, metricLinks.nth(1), "second metric link");
});

test("the dashboard threshold disclosure and dataset select follow the invariant", async ({
  page,
}) => {
  await enter(page, "/dashboard");
  const summary = page.locator("summary", {
    hasText: "Adjust waiting thresholds",
  });
  await probe(page, summary, "threshold disclosure summary", "light");
  await summary.click();
  const select = page.getByLabel("Show requests", { exact: true });
  await expectFieldFocus(page, select, "dashboard dataset select");
});

test("header controls on the dark banner keep non-blue, light-reading focus", async ({
  page,
}) => {
  await enter(page, "/review");
  const brand = page.locator("header a").first();
  await expectPointerQuiet(page, brand, "header brand link");
  await expectKeyboardOutline(page, "header brand link", "dark");
  await expect(brand).toBeFocused();
  await enter(page, "/review");
  const demoView = page.getByLabel("Choose view", { exact: true });
  await expectFieldFocus(page, demoView, "Demo view select");
  await page.keyboard.press("Escape");
});

test("sidebar and breadcrumb links stay quiet under the pointer", async ({
  page,
}) => {
  await enter(page, "/admin/requests");
  await probe(
    page,
    page.getByRole("link", { name: "Catalog", exact: true }).first(),
    "sidebar Catalog link",
    "light",
  );
  const { rows } = await browserRead(
    page,
    "/api/queue?reviewer=all&sort=waiting",
  );
  await enter(page, "/review/" + rows[0].requestId);
  await expectPointerQuiet(
    page,
    page.getByRole("link", { name: "Review queue" }).first(),
    "breadcrumb link",
  );
});

test("queue body links, header sort buttons, and the scroll region stay quiet", async ({
  page,
}) => {
  await enter(page, "/review");
  await probe(
    page,
    page.locator("thead button").first(),
    "queue sort heading button",
    "light",
  );
  await expectPointerQuiet(
    page,
    page.getByRole("region", { name: /Request list/ }),
    "queue scroll region",
  );
  await expectPointerQuiet(
    page,
    page.locator("tbody a[href]").first(),
    "queue row title link",
  );
});

test("ordinary USWDS buttons stay quiet on click and mark keyboard focus without blue", async ({
  page,
}) => {
  await enter(page, "/review");
  const toggle = page.getByRole("button", { name: /design notes/ });
  await probe(page, toggle, "design notes toggle button", "light");
  await toggle.click();
});

test("queue filter selects show visible non-blue entry focus", async ({
  page,
}) => {
  await enter(page, "/review");
  const phase = page.getByLabel("Stage", { exact: true });
  await expectFieldFocus(page, phase, "Phase filter select");
  await page.keyboard.press("Escape");
});

test("priority factor fields carry no blue in either modality", async ({
  page,
}) => {
  await enter(page, "/review");
  const { rows } = await browserRead(
    page,
    "/api/queue?reviewer=all&sort=waiting",
  );
  const scored = rows.find(
    (row: { phase: string; score: number | null }) =>
      row.phase === "review" && row.score !== null,
  );
  expect(scored, "a scored in-review request exists").toBeTruthy();
  await enter(page, "/review/" + scored.requestId);
  const card = page.locator('#priority [data-factor="effort"]');
  // The pointer probe's click also opens the factor's editor panel.
  await expectPointerQuiet(
    page,
    card.locator("button[aria-expanded]").first(),
    "priority factor edit toggle",
  );
  const action = card.getByLabel("How will you handle this estimate?", {
    exact: true,
  });
  await expectFieldFocus(page, action, "factor action select");
  await action.selectOption("replace");
  await expectFieldFocus(
    page,
    card.getByLabel("Total working days", { exact: true }),
    "factor value field",
  );
});

test("history disclosures on the review record stay quiet on click", async ({
  page,
}) => {
  await enter(page, "/review");
  const { rows } = await browserRead(
    page,
    "/api/queue?reviewer=all&sort=waiting",
  );
  await enter(page, "/review/" + rows[0].requestId);
  await page
    .getByRole("link", { name: "Request history", exact: true })
    .click();
  const summary = page.locator("summary", {
    hasText: "Activity and decisions",
  });
  await probe(page, summary, "history disclosure summary", "light");
  await summary.click();
});

test("review completion radios stay quiet on click and mark keyboard focus without blue", async ({
  page,
}) => {
  await enter(page, "/review");
  const { rows } = await browserRead(
    page,
    "/api/queue?reviewer=all&sort=waiting",
  );
  const reviewing = rows.filter(
    (row: { phase: string }) => row.phase === "review",
  );
  const target = await completionReadyTarget(page, reviewing);
  expect(target, "a review whose holds drafts can clear exists").toBeTruthy();
  await enter(page, "/review/" + target!.requestId);
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
  // The rating radios render only once the completion form opens, so the
  // probe first drafts the decisions that clear the hold — never by
  // forcing or bypassing the disabled state.
  await settleClaims(page, "#fit", "Accept option");
  await settleClaims(page, "#risk", "Confirm finding");
  const radio = page
    .locator('#completion .task-rating input[type="radio"]')
    .first();
  await expect(radio).toBeVisible();
  await probe(page, radio, "resolution rating radio", "light");
});

const draftClearable = new Set([
  "ASSET_OUTCOME_PENDING",
  "RISK_FINDINGS_UNDECIDED",
  "RISK_OUTCOME_PENDING",
]);

/* Completion opens only when every remaining hold is a decision the test
 * can draft: no stale corpora, clarifications, open questions, or
 * missing-information findings that demand a rationale. */
async function completionReadyTarget(
  page: Page,
  rows: Array<{ requestId: string }>,
) {
  for (const row of rows) {
    const view = await browserRead(
      page,
      "/api/request-view/" + row.requestId + "?view=contributor",
    );
    const blockers: string[] = (view.review?.blockers ?? []).filter(
      (blocker: string) => blocker !== "NEXT_OWNER_MISSING",
    );
    if (!blockers.every((blocker) => draftClearable.has(blocker))) continue;
    const questioned = (view.inputRequests ?? []).some(
      (question: { area: string; current: boolean; state: string }) =>
        (question.area === "assets" || question.area === "risk") &&
        question.current &&
        question.state !== "resolved",
    );
    if (questioned) continue;
    const undecidable = (view.findings ?? []).some(
      (finding: { kind: string; decision: string | null }) =>
        finding.kind === "missing_information" && !finding.decision,
    );
    if (!undecidable) return row;
  }
  return null;
}

/* Draft one outcome per claim through the panels; an empty section takes
 * its affirmation checkbox instead. The section renders after the record
 * data arrives, so wait for it before counting — an early count of zero
 * would silently settle nothing. */
async function settleClaims(page: Page, section: string, verb: string) {
  await expect(page.locator(section)).toBeVisible();
  const claims = page.locator(section + " button[data-claim]");
  const count = await claims.count();
  for (let index = 0; index < count; index++) {
    await claims.nth(index).click();
    const panel = page.locator(section + " [data-claimpanel]");
    await panel.getByRole("button", { name: verb, exact: true }).click();
  }
  if (count === 0) {
    const affirmation = page.locator(section + ' input[type="checkbox"]');
    await expect(affirmation.first()).toBeVisible();
    await affirmation.first().check();
  }
}

test("the USWDS checkbox label pseudo-element obeys the invariant", async ({
  page,
}) => {
  await enter(page, "/admin/demo");
  const box = page.locator('input[type="checkbox"]').first();
  await expect(box).toBeVisible();
  await probe(
    page,
    page.locator('label[for="confirm-fixture-restore"]'),
    "restore confirmation checkbox",
    "light",
  );
  await page.locator('label[for="confirm-fixture-restore"]').click();
});

test("requester intake keeps a visible non-blue textarea focus and quiet buttons", async ({
  page,
}) => {
  await enter(page, "/new");
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible();
  await expectFieldFocus(page, textarea, "intake textarea");
  const button = page.locator("main").getByRole("button").first();
  await expectPointerQuiet(page, button, "intake button");
});
