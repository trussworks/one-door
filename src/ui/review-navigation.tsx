"use client";

import type { RequestView } from "../server/request-views";

export const reviewSections = {
  assessment: "Assessment",
  delivery: "Delivery",
  history: "History",
} as const;
export type ReviewSection = keyof typeof reviewSections;

/** Older links used one section per decision area; the prepared assessment
 * now carries all of them, so those values land on the assessment. */
const legacySections: Record<string, ReviewSection> = {
  request: "assessment",
  matches: "assessment",
  risk: "assessment",
  priority: "assessment",
  finish: "assessment",
};

export function selectedReviewSection(value: string | null): ReviewSection {
  if (value && Object.hasOwn(reviewSections, value))
    return value as ReviewSection;
  if (value && Object.hasOwn(legacySections, value))
    return legacySections[value];
  return "assessment";
}

export function reviewSectionHref(
  path: string,
  query: string,
  section: ReviewSection,
) {
  const next = new URLSearchParams(query);
  next.set("section", section);
  next.delete("panel");
  return path + "?" + next;
}

export function nextReviewSection(data: RequestView): ReviewSection {
  const action = data.status?.actionNeeded;
  const destinations: Record<string, ReviewSection> = {
    review_assets: "assessment",
    review_risk: "assessment",
    score_rice: "assessment",
    complete_first_review: "assessment",
    wait_for_requester: "assessment",
    retry_handoff: "delivery",
    execute_handoff: "delivery",
    monitor_delivery: "delivery",
    record_outcome: "delivery",
    none: "delivery",
  };
  if (action && destinations[action]) return destinations[action];
  return "assessment";
}
