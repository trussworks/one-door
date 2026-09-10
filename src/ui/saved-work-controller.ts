import { api, ApiError } from "./api";

type Values = Record<string, string>;

export type SavedWorkKind =
  | "loading"
  | "idle"
  | "loaded"
  | "recovered"
  | "loadFailed"
  | "saving"
  | "queued"
  | "saved"
  | "conflict"
  | "failed";

export interface SavedWorkStatus {
  kind: SavedWorkKind;
  message: string;
}

export const savedWorkStatus: Record<SavedWorkKind, SavedWorkStatus> = {
  loading: { kind: "loading", message: "Loading your draft…" },
  idle: { kind: "idle", message: "No draft changes." },
  loaded: { kind: "loaded", message: "Your saved draft has loaded." },
  recovered: {
    kind: "recovered",
    message:
      "Entries recovered from this browser's backup. Their server save is unconfirmed.",
  },
  loadFailed: {
    kind: "loadFailed",
    message:
      "Your draft could not load. Check your connection and reload to try again.",
  },
  saving: { kind: "saving", message: "Saving your draft…" },
  queued: { kind: "queued", message: "Draft changes waiting to save…" },
  saved: { kind: "saved", message: "Your draft is saved." },
  conflict: {
    kind: "conflict",
    message:
      "A newer draft is already saved on the server. These changes were not saved over it.",
  },
  failed: {
    kind: "failed",
    message:
      "Draft save could not be confirmed. Your entries remain in this open form. Retry saving before leaving.",
  },
};
export interface Scope {
  visitorId: string;
  actingView: string;
  pageKey: string;
  subjectKey: string;
}
export interface Saved {
  payload: Values;
  rowVersion: number;
}
interface Backup {
  values: Values;
  unsent: boolean;
  rowVersion?: number;
}
export interface Controller {
  values: Values;
  rowVersion: number;
  sequence: number;
  savedSequence: number;
  ready: boolean;
  mounted: boolean;
  pending: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  loadId: number;
  route: string;
}

function readBackup(key: string): Backup | null {
  try {
    const { values, unsent, rowVersion } = JSON.parse(
      localStorage.getItem(key) ?? "null",
    );
    if (!validValues(values) || typeof unsent !== "boolean") return null;
    if (rowVersion !== undefined && !validVersion(rowVersion)) return null;
    return { values, unsent, rowVersion };
  } catch {
    return null;
  }
}
function validValues(values: unknown): values is Values {
  return (
    Boolean(values) &&
    typeof values === "object" &&
    !Array.isArray(values) &&
    Object.values(values as object).every((value) => typeof value === "string")
  );
}
function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function keepBackup(key: string, controller: Controller, unsent: boolean) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        values: controller.values,
        unsent,
        rowVersion: controller.rowVersion,
      }),
    );
  } catch {
    /* beforeunload still protects unconfirmed server writes. */
  }
}
function confirmBackup(key: string, controller: Controller, unsent: boolean) {
  // A late response must not replace edits made after the same form reopened.
  const backup = readBackup(key);
  if (JSON.stringify(backup?.values) === JSON.stringify(controller.values))
    keepBackup(key, controller, unsent);
}
export function createController(values: Values): Controller {
  return {
    values,
    rowVersion: 0,
    sequence: 0,
    savedSequence: 0,
    ready: false,
    mounted: true,
    pending: null,
    timer: null,
    loadId: 0,
    route:
      typeof window === "undefined" ? "/" : location.pathname + location.search,
  };
}
function restoredWork(
  saved: Saved | null,
  backup: Backup | null,
  initial: Values,
) {
  // Reopening unsent work must not authorize overwriting another tab's newer save.
  if (backup?.unsent)
    return {
      values: backup.values,
      rowVersion: backup.rowVersion ?? 0,
      sequence: 1,
    };
  return {
    values: saved?.payload ?? initial,
    rowVersion: saved?.rowVersion ?? 0,
    sequence: 0,
  };
}

/** Concurrency tokens: the record they came from decides these, not an edit. */
const concurrencyKeys = ["_recordVersion", "_itemVersion"];

/** A saved position in the RICE sequence is navigation, not an edit. */
const navigationKeys = ["_step"];

const comparedAsEdit = (key: string) =>
  !concurrencyKeys.includes(key) && !navigationKeys.includes(key);

export function sameEditableValues(values: Values, initial: Values) {
  return [...new Set([...Object.keys(values), ...Object.keys(initial)])]
    .filter(comparedAsEdit)
    .every((key) => (values[key] ?? "") === (initial[key] ?? ""));
}

function isVersionToken(key: string) {
  return concurrencyKeys.includes(key);
}

export function refreshUnchangedTokens(
  controller: Controller,
  latest: Values,
  key: string,
) {
  if (!controller.ready || !sameEditableValues(controller.values, latest))
    return false;
  const tokens = Object.entries(latest).filter(
    ([name, value]) =>
      isVersionToken(name) && value !== controller.values[name],
  );
  if (!tokens.length) return false;
  const previous = controller.values;
  const backup = readBackup(key);
  controller.values = { ...controller.values, ...Object.fromEntries(tokens) };
  // Keep our backup comparable with the pending save's acknowledgement.
  // Another panel's values or newer draft version still belong to that panel.
  if (
    backup &&
    backup.rowVersion === controller.rowVersion &&
    JSON.stringify(backup.values) === JSON.stringify(previous)
  )
    keepBackup(key, controller, backup.unsent);
  return true;
}

async function persist(
  controller: Controller,
  key: string,
  status: (value: SavedWorkStatus) => void,
) {
  if (!controller.ready || controller.sequence === controller.savedSequence)
    return;
  const sequence = controller.sequence;
  if (controller.mounted) status(savedWorkStatus.saving);
  try {
    const saved = await api<Saved>("/api/wip", {
      ...JSON.parse(key),
      payload: { ...controller.values },
      expectedRowVersion: controller.rowVersion,
      route: controller.route,
    });
    controller.rowVersion = saved.rowVersion;
    controller.savedSequence = sequence;
    confirmBackup(key, controller, controller.sequence !== sequence);
    if (controller.mounted)
      status(
        controller.sequence === sequence
          ? savedWorkStatus.saved
          : savedWorkStatus.queued,
      );
  } catch (error) {
    if (controller.mounted)
      status(
        error instanceof ApiError && error.code === "VERSION_CONFLICT"
          ? savedWorkStatus.conflict
          : savedWorkStatus.failed,
      );
    throw error;
  }
}

export function queueSave(
  controller: Controller,
  key: string,
  status: (value: SavedWorkStatus) => void,
) {
  if (controller.timer) clearTimeout(controller.timer);
  const previous = controller.pending ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => persist(controller, key, status));
  controller.pending = task;
  return task.finally(() => {
    if (controller.pending === task) controller.pending = null;
  });
}

export async function loadSaved(
  controller: Controller,
  key: string,
  initial: Values,
  loadId: number,
) {
  const { actingView, pageKey, subjectKey } = JSON.parse(key) as Scope;
  const path =
    "/api/wip?" + new URLSearchParams({ actingView, pageKey, subjectKey });
  const saved = await api<Saved | null>(path);
  if (!controller.mounted || controller.loadId !== loadId) return null;
  const backup = readBackup(key);
  Object.assign(controller, restoredWork(saved, backup, initial));
  controller.savedSequence = 0;
  controller.ready = true;
  if (backup?.unsent) return savedWorkStatus.recovered;
  return saved ? savedWorkStatus.loaded : savedWorkStatus.idle;
}

export function changeSavedWork(
  controller: Controller,
  key: string,
  update: { name: string; value: string; route: string },
) {
  if (!controller.ready) return;
  controller.values = { ...controller.values, [update.name]: update.value };
  controller.route = update.route;
  controller.sequence += 1;
  keepBackup(key, controller, true);
}
