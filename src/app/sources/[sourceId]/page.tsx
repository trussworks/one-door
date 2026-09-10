import { SourcePage } from "../../../ui/sources";
export default async function Page({
  params,
}: {
  params: Promise<{ sourceId: string }>;
}) {
  return <SourcePage id={(await params).sourceId} />;
}
