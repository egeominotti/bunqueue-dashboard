import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <h1 className="text-5xl font-bold text-faint">404</h1>
      <p className="text-sm text-muted">This page does not exist.</p>
      <Link
        to="/"
        className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        Back to Overview
      </Link>
    </div>
  );
}
