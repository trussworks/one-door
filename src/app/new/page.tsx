import { Suspense } from "react";
import { NewRequest } from "../../ui/intake";
export default function Page() {
  return (
    <Suspense fallback={<p>Loading your request…</p>}>
      <NewRequest />
    </Suspense>
  );
}
