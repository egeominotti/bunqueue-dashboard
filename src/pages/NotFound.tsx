import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="text-5xl font-bold text-faint">404</div>
      <p className="text-sm text-muted">This page does not exist.</p>
      <Link
        to="/"
        className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-line-strong"
      >
        Back to Overview
      </Link>
    </div>
  );
}
