import EngagementClient from "./EngagementClient";

export default async function EngagementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EngagementClient engagementId={id} />;
}
