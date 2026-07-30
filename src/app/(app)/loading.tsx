export default function Loading() {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-24 animate-pulse rounded-[var(--radius-card)] bg-surface-muted"
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
