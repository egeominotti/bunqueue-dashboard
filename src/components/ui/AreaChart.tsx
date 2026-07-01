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
}: {
  series: ChartSeries[];
  height?: number;
  xLabels?: string[];
}) {
  const gid = useId().replace(/:/g, '');
  const W = 600;
  const H = height;
  const padY = 10;
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const maxLen = Math.max(1, ...series.map((s) => s.points.length));
  const max = Math.max(1, ...series.flatMap((s) => s.points.map(finite)));

  const x = (i: number) => (maxLen <= 1 ? 0 : (i / (maxLen - 1)) * W);
  const y = (v: number) => H - padY - (finite(v) / max) * (H - padY * 2);

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (H - padY * 2));

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-44 w-full"
        role="img"
        aria-label="throughput chart"
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
          const line = s.points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
          const area = `${line} L${x(s.points.length - 1)},${H} L${x(0)},${H} Z`;
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
      {xLabels && (
        <div className="mt-1 flex justify-between px-1 font-mono text-[10px] text-faint">
          {xLabels.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}
