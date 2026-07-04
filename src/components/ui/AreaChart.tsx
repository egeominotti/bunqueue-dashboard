import { useId } from 'react';

export interface ChartSeries {
  label: string;
  /** CSS color (hex or var). */
  color: string;
  points: number[];
  /** Fill an area gradient under the line. */
  area?: boolean;
}

/**
 * Lightweight multi-series line/area chart (pure SVG, no dependency).
 * Renders a rolling window; x maps left→right over the point count.
 */
export function AreaChart({
  series,
  height = 180,
  xLabels,
  ariaLabel = 'throughput chart',
  formatValue,
}: {
  series: ChartSeries[];
  height?: number;
  xLabels?: string[];
  ariaLabel?: string;
  /** Format y-scale labels and the accessible summary (defaults to plain numbers). */
  formatValue?: (v: number) => string;
}) {
  const gid = useId().replace(/:/g, '');
  const descId = `${gid}-desc`;
  const W = 600;
  const H = height;
  const padY = 10;
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const maxLen = Math.max(1, ...series.map((s) => s.points.length));
  const max = Math.max(1, ...series.flatMap((s) => s.points.map(finite)));

  const x = (i: number) => (maxLen <= 1 ? 0 : (i / (maxLen - 1)) * W);
  const y = (v: number) => H - padY - (finite(v) / max) * (H - padY * 2);

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (H - padY * 2));

  const fmt = formatValue ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
  const hasData = series.some((s) => s.points.length > 0);
  // Latest value of the first (primary) series, for the accessible summary.
  const first = series.find((s) => s.points.length > 0);
  const latest = first ? finite(first.points[first.points.length - 1]) : 0;

  return (
    <div className="w-full">
      {/* Relative wrapper covers the svg only, so the y-scale labels align with
          the gridlines (viewBox height == rendered height; y maps 1:1). */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height }}
          role="img"
          aria-label={ariaLabel}
          aria-describedby={descId}
        >
          <defs>
            {series.map((s, si) => (
              <linearGradient key={s.label} id={`${gid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {gridYs.map((gy) => (
            <line key={gy} x1="0" y1={gy} x2={W} y2={gy} stroke="var(--line)" strokeWidth="1" />
          ))}

          {series.map((s, si) => {
            if (s.points.length === 0) return null;
            // One point has no extent — draw it as a flat line across the full
            // width instead of an invisible zero-length path.
            const line =
              s.points.length === 1
                ? `M0,${y(s.points[0])} L${W},${y(s.points[0])}`
                : s.points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
            const area =
              s.points.length === 1
                ? `${line} L${W},${H} L0,${H} Z`
                : `${line} L${x(s.points.length - 1)},${H} L${x(0)},${H} Z`;
            return (
              <g key={s.label}>
                {s.area && <path d={area} fill={`url(#${gid}-g${si})`} />}
                <path
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>
        {/* Y-scale: max sits on the top gridline (padY px), mid on the middle one
            (exactly 50% since padY + 0.5·(H − 2·padY) = H/2). */}
        {hasData && (
          <>
            <span
              className="pointer-events-none absolute left-1 -translate-y-full font-mono text-[10px] leading-none text-faint"
              style={{ top: padY }}
            >
              {fmt(max)}
            </span>
            <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 font-mono text-[10px] leading-none text-faint">
              {fmt(max / 2)}
            </span>
          </>
        )}
      </div>
      {xLabels && (
        <div className="mt-1 flex justify-between px-1 font-mono text-[10px] text-faint">
          {xLabels.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
      <p id={descId} className="sr-only">
        {hasData ? `latest ${fmt(latest)}, max ${fmt(max)}` : 'no data yet'}
      </p>
    </div>
  );
}
