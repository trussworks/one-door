import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { isCurrentReviewInput } from "../src/domain/review-inputs.ts";
import {
  answerReviewInputSchema,
  askReviewInputSchema,
} from "../src/workflow/review-inputs.ts";

const question = {
  requestId: randomUUID(),
  inputRequestId: randomUUID(),
  expectedRowVersion: 1,
  area: "rice",
  audience: "internal",
  factor: "effort",
  question: "What effort covers deployment in all three offices?",
  expertise: "Delivery estimation",
};

it("requires useful allocation context without inventing an assignee", () => {
  expect(askReviewInputSchema.parse(question).assigneeActorId).toBeUndefined();
  expect(
    askReviewInputSchema.safeParse({ ...question, expertise: undefined })
      .success,
  ).toBe(false);
  expect(
    askReviewInputSchema.safeParse({
      ...question,
      expertise: undefined,
      assigneeActorId: randomUUID(),
    }).success,
  ).toBe(true);
});

it("separates requester questions and rejects target/audience contradictions", () => {
  expect(
    askReviewInputSchema.safeParse({
      ...question,
      audience: "requester",
      expertise: undefined,
    }).success,
  ).toBe(true);
  expect(
    askReviewInputSchema.safeParse({
      ...question,
      audience: "requester",
      assigneeActorId: randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    askReviewInputSchema.safeParse({ ...question, findingId: randomUUID() })
      .success,
  ).toBe(false);
  expect(
    askReviewInputSchema.safeParse({ ...question, area: "risk" }).success,
  ).toBe(false);
  expect(
    askReviewInputSchema.safeParse({ ...question, factor: undefined }).success,
  ).toBe(false);
});

it("never accepts a caller-supplied respondent or recorder", () => {
  const answer = {
    requestId: question.requestId,
    inputRequestId: question.inputRequestId,
    responseId: randomUUID(),
    expectedRowVersion: 2,
    expectedInputVersion: 1,
    answer: "I do not know the integration effort.",
    outcome: "unknown",
  };
  expect(answerReviewInputSchema.safeParse(answer).success).toBe(true);
  expect(
    answerReviewInputSchema.safeParse({
      ...answer,
      respondentActorId: randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    answerReviewInputSchema.safeParse({
      ...answer,
      recordedByActorId: randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    answerReviewInputSchema.safeParse({
      ...answer,
      proposal: { factor: "effort", estimate: { value: 1, basis: "Guess" } },
    }).success,
  ).toBe(false);
});

it("requires exact revision and generation without treating null as a wildcard", () => {
  const request = { currentRevisionId: null, fixtureGeneration: 2 };
  expect(
    isCurrentReviewInput({ revisionId: null, requestGeneration: 2 }, request),
  ).toBe(true);
  expect(
    isCurrentReviewInput({ revisionId: null, requestGeneration: 1 }, request),
  ).toBe(false);
  expect(
    isCurrentReviewInput(
      { revisionId: randomUUID(), requestGeneration: 2 },
      request,
    ),
  ).toBe(false);
});

it("binds targeted questions to the selected assessment, including corpus reversion", () => {
  const request = { currentRevisionId: null, fixtureGeneration: 1 };
  const assessmentA = randomUUID();
  const assessmentB = randomUUID();
  const risk = {
    revisionId: null,
    requestGeneration: 1,
    findingId: randomUUID(),
    findingAssessmentId: assessmentA,
  };
  const asset = {
    revisionId: null,
    requestGeneration: 1,
    candidateId: randomUUID(),
    candidateAssessmentId: assessmentA,
  };
  expect(isCurrentReviewInput(risk, request)).toBe(false);
  expect(
    isCurrentReviewInput(risk, request, {
      assetAssessmentId: null,
      riskAssessmentId: assessmentB,
    }),
  ).toBe(false);
  expect(
    isCurrentReviewInput(risk, request, {
      assetAssessmentId: null,
      riskAssessmentId: assessmentA,
    }),
  ).toBe(true);
  expect(
    isCurrentReviewInput(asset, request, {
      assetAssessmentId: assessmentB,
      riskAssessmentId: null,
    }),
  ).toBe(false);
  expect(
    isCurrentReviewInput(asset, request, {
      assetAssessmentId: assessmentA,
      riskAssessmentId: null,
    }),
  ).toBe(true);
});
