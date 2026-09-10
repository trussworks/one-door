import { WorkItemPage } from "../../../ui/work-item";
export default async function Page({
  params,
}: {
  params: Promise<{ workItemId: string }>;
}) {
  return <WorkItemPage id={(await params).workItemId} />;
}
