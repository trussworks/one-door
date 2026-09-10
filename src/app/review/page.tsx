import { Suspense } from "react";
import { ReviewQueue } from "../../ui/review-queue";

export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading the queue…</p>}>
      <ReviewQueue />
    </Suspense>
  );
}
