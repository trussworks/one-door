import { Suspense } from "react";
import { Reports } from "../../ui/reports";
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading reports…</p>}>
      <Reports />
    </Suspense>
  );
}
