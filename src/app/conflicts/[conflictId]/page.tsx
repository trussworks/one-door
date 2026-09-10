import { ConflictPage } from "../../../ui/conflict";
export default async function Page({
  params,
}: {
  params: Promise<{ conflictId: string }>;
}) {
  return <ConflictPage id={(await params).conflictId} />;
}
