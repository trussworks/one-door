import { Suspense } from "react";
import { NewCatalogItem } from "../../../ui/catalog-record";
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Starting the catalog draft…</p>}>
      <NewCatalogItem />
    </Suspense>
  );
}
