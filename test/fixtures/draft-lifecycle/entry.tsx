import { Suspense, startTransition, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RequestView } from "../../../src/server/request-views";
import type { PriorityView } from "../../../src/domain/priority";
import { PriorityFactors } from "../../../src/ui/priority-contributions";
import { createDraftStore } from "../../../src/ui/review-brief";
import { RecordMutationContext } from "../../../src/ui/record-form";

const store = createDraftStore();
const never = new Promise<void>(() => {});
const priority = {
  complete: false,
  score: null,
  factors: [
    { factor: "reach", status: "missing", proposals: [], reviewed: null },
  ],
} as unknown as PriorityView;
const coordination = { busy: { current: false }, setBusy: () => {} };

function snapshot() {
  return Array.from(store.registry, ([key, entry]) => ({
    key,
    values: entry.values,
    ready: entry.ready,
  }));
}
declare global {
  interface Window {
    draftProbe: {
      attempted: boolean;
      cancellation: number;
      snapshot: typeof snapshot;
    };
  }
}
window.draftProbe = { attempted: false, cancellation: 0, snapshot };

function Suspend({ active }: { active: boolean }) {
  if (active) {
    // Observe that React attempted this render, even though it cannot commit.
    window.draftProbe.attempted = true;
    throw never;
  }
  return null;
}

function App() {
  const [second, setSecond] = useState(false);
  const [cancellation, setCancellation] = useState(0);
  useLayoutEffect(() => {
    window.draftProbe.cancellation = cancellation;
  }, [cancellation]);
  const requestId = second ? "second" : "first";
  const data = {
    record: { requestId, rowVersion: 1, displayId: requestId },
  } as RequestView;
  return (
    <>
      <button onClick={() => startTransition(() => setSecond(true))}>
        Start transition
      </button>
      <button
        onClick={() => {
          setSecond(false);
          setCancellation((value) => value + 1);
        }}
      >
        Cancel transition
      </button>
      <Suspense fallback={<div data-fallback />}>
        <RecordMutationContext.Provider value={coordination}>
          <div data-request={requestId}>
            <PriorityFactors
              data={data}
              changed={() => {}}
              priority={priority}
              mutable
              register={(factor, values, owner) =>
                store.register("priority", factor, values, owner)
              }
            />
          </div>
          <Suspend active={second} />
        </RecordMutationContext.Provider>
      </Suspense>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
