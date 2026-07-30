const LABELS: Record<string, string> = {
  free: 'Free',
  launch: 'Launch',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
};

export default function OrgBadge({ plan }: { plan: string }) {
  return <span className="chip">{LABELS[plan] ?? plan} plan</span>;
}
