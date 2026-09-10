import { Suspense } from "react";
import { Catalog } from "../../ui/catalog";
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading the catalog…</p>}>
      <Catalog />
    </Suspense>
  );
}
