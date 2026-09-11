"use client";

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
