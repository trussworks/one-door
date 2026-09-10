import { ObservationPage } from "../../../ui/sources";
export default async function Page({
  params,
}: {
  params: Promise<{ recordId: string }>;
}) {
  return <ObservationPage id={(await params).recordId} />;
}
