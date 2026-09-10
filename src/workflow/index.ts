/**
 * Server-side workflow contract for Next handlers.
 *
 * Every function validates its own input, checks ownership and state on the
 * server, returns plain serializable data, and throws WorkflowError with a
 * stable code from workflowErrorCodes on failure.
 */
export { WorkflowError, workflowErrorCodes } from "./errors.ts";
export type { WorkflowErrorCode } from "./errors.ts";
export type { ActorContext, RequestContent, VisitorContext } from "./shared.ts";
export { requestContentSchema } from "./shared.ts";
export {
  createVisitor,
  getOwnDraft,
  getOwnRequest,
  listOwnWork,
  saveDraft,
  submitRequest,
} from "./requester.ts";
export {
  answerClarification,
  askClarification,
  getRequestRecord,
} from "./clarification.ts";
export {
  assignReview,
  getReviewState,
  recordAssetOutcome,
  recordRiskOutcome,
  recordRouting,
  saveAssetDecision,
  saveRiceScore,
  saveRiskDecision,
} from "./review.ts";
export type { ApprovalBlocker } from "./review.ts";
export {
  completeFirstReview,
  deriveWorkItemHealth,
  executeHandoff,
  getDeliveryState,
  linkWorkItem,
  resolveRequest,
  updateWorkItemStatus,
} from "./delivery.ts";
export {
  addCatalogItem,
  confirmCatalogItemAccurate,
  getCatalogItemRecord,
  publishCatalogItem,
  retireCatalogItem,
  reviseCatalogItem,
} from "./catalog.ts";
export {
  getConflictComparison,
  getSourceHistory,
  registerSource,
  resolveConflict,
  retireSource,
  updateSource,
} from "./inventory.ts";
export {
  addAdministratorNote,
  importFixture,
  resetFixtures,
  type AdministratorNote,
} from "./admin.ts";
export {
  answerIntake,
  confirmIntake,
  decideAssetFit,
  decideService,
  getAssetPreview,
  getIntakeState,
} from "./intake.ts";
export {
  getIntakeWorkspace,
  prepareIntake,
  submitIntake,
} from "./intake-workspace.ts";
