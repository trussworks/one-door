import { Suspense } from "react";
import { RequestRecord } from "../../../../ui/request-record";

export default async function Page({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  return (
    <Suspense fallback={<p role="status">Loading the request…</p>}>
      <RequestRecord requestId={requestId} administrative />
    </Suspense>
  );
}
