import { Suspense } from "react";
import { CatalogItemPage } from "../../../ui/catalog-record";
export default async function Page({
  params,
}: {
  params: Promise<{ catalogItemId: string }>;
}) {
  return (
    <Suspense fallback={<p role="status">Loading the item…</p>}>
      <CatalogItemPage id={(await params).catalogItemId} />
    </Suspense>
  );
}
