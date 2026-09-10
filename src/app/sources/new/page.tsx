import { Suspense } from "react";
import { NewSource } from "../../../ui/sources";
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Starting the source definition…</p>}>
      <NewSource />
    </Suspense>
  );
}
