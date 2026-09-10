import { Suspense } from "react";
import { Dashboard } from "../../ui/dashboard";
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading the dashboard…</p>}>
      <Dashboard />
    </Suspense>
  );
}
