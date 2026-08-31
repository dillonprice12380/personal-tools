import React, { useState } from 'react';
import { useMeasure } from './ui';

/**
 * Charts are hand-rolled SVG rather than a charting library: the shapes Helm
 * needs are simple, and this keeps the bundle small and the styling consistent
 * with the rest of the app.
 *
 * Conventions follow one house style: thin marks, 4px rounded data-ends
 * anchored to the baseline, a 2px surface gap between adjacent fills, recessive
 * grid and axes, a legend whenever more than one series is present, and a hover
 * tooltip on every plotted mark.
 */

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

type TooltipState = { x: number; y: number; title: string; rows: Array<{ label: string; value: string; color?: string }> } | null;

function Tooltip({ state }: { state: TooltipState }) {
  if (!state) return null;
  return (
    <div className="tooltip" style={{ left: state.x + 12, top: state.y + 12 }} role="tooltip">
      <div className="tt-title">{state.title}</div>
      {state.rows.map((row) => (
        <div className="tt-row" key={row.label}>
          <span className="k">
            {row.color && <span className="legend-swatch" style={{ background: row.color }} />}
            {row.label}
          </span>
          <strong className="tabular">{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend-item" key={item.label}>
          <span className="legend-swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export type BarSeries = { label: string; color?: string; values: number[] };

/**
 * Grouped vertical bars. One measure per series on a single shared axis -
 * never two scales, which would make the comparison meaningless.
 */
export function BarChart({
  categories,
  series,
  height = 190,
  format = (v: number) => String(v),
}: {
  categories: string[];
  series: BarSeries[];
  height?: number;
  format?: (value: number) => string;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState>(null);

  const pad = { top: 12, right: 8, bottom: 24, left: 46 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = [0, max / 2, max];

  const groupW = categories.length ? plotW / categories.length : 0;
  const GAP = 2;
  const MAX_BAR = 46;
  const barW = Math.min(
    MAX_BAR,
    Math.max(3, (groupW * 0.68) / Math.max(1, series.length) - (series.length > 1 ? GAP : 0))
  );

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {width > 0 && (
        <svg className="chart" width={width} height={height} role="img">
          {ticks.map((tick, i) => {
            const y = pad.top + plotH - (tick / max) * plotH;
            return (
              <g key={i}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="var(--grid)" strokeWidth="1" />
                <text x={pad.left - 7} y={y + 3.5} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                  {format(tick)}
                </text>
              </g>
            );
          })}

          {categories.map((category, ci) => {
            const groupX = pad.left + ci * groupW;
            const totalW = series.length * barW + (series.length - 1) * GAP;
            const startX = groupX + (groupW - totalW) / 2;
            return (
              <g key={category}>
                {series.map((s, si) => {
                  const value = s.values[ci] ?? 0;
                  const h = Math.max(value > 0 ? 2 : 0, (value / max) * plotH);
                  const x = startX + si * (barW + GAP);
                  const y = pad.top + plotH - h;
                  const color = s.color ?? SERIES[si % SERIES.length];
                  return (
                    <rect
                      key={s.label}
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                      rx={Math.min(4, barW / 2)}
                      fill={color}
                      onMouseMove={(e) =>
                        setTip({
                          x: e.clientX,
                          y: e.clientY,
                          title: category,
                          rows: series.map((row, ri) => ({
                            label: row.label,
                            value: format(row.values[ci] ?? 0),
                            color: row.color ?? SERIES[ri % SERIES.length],
                          })),
                        })
                      }
                      onMouseLeave={() => setTip(null)}
                    />
                  );
                })}
                <text
                  x={groupX + groupW / 2}
                  y={height - 7}
                  textAnchor="middle"
                  fontSize="10.5"
                  fill="var(--text-muted)"
                >
                  {category}
                </text>
              </g>
            );
          })}

          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + plotH}
            y2={pad.top + plotH}
            stroke="var(--axis)"
            strokeWidth="1"
          />
        </svg>
      )}
      <Tooltip state={tip} />
    </div>
  );
}

/** Horizontal ranked bars - the right form for "biggest categories". */
export function RankedBars({
  items,
  format = (v: number) => String(v),
  color = 'var(--series-1)',
  max: maxOverride,
}: {
  items: Array<{ label: string; value: number; color?: string }>;
  format?: (value: number) => string;
  color?: string;
  max?: number;
}) {
  const max = Math.max(1, maxOverride ?? Math.max(...items.map((i) => i.value), 0));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((item) => (
        <div key={item.label}>
          <div className="row between small" style={{ marginBottom: 3 }}>
            <span className="truncate row" style={{ gap: 6 }}>
              <span
                className="legend-swatch"
                style={{ background: item.color ?? color, flex: 'none' }}
              />
              {item.label}
            </span>
            <strong className="tabular">{format(item.value)}</strong>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(item.value / max) * 100}%`, background: item.color ?? color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Line chart with a crosshair. Used for rank history, where the y-axis is
 * inverted (position 1 is best) - `invert` handles that without a second scale.
 */
export function LineChart({
  points,
  height = 150,
  invert = false,
  format = (v: number) => String(v),
  color = 'var(--series-1)',
  label = 'Value',
}: {
  points: Array<{ x: string; y: number | null }>;
  height?: number;
  invert?: boolean;
  format?: (value: number) => string;
  color?: string;
  label?: string;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState>(null);
  const [hover, setHover] = useState<number | null>(null);

  const pad = { top: 12, right: 10, bottom: 22, left: 34 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  const values = points.map((p) => p.y).filter((v): v is number => v !== null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const lo = invert ? min - span * 0.15 : Math.min(0, min);
  const hi = max + span * 0.15;

  const xAt = (i: number) => pad.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const yAt = (v: number) => {
    const t = (v - lo) / Math.max(1e-9, hi - lo);
    return pad.top + (invert ? t * plotH : plotH - t * plotH);
  };

  const path = points
    .map((p, i) => (p.y === null ? null : `${i === 0 || points[i - 1]?.y === null ? 'M' : 'L'}${xAt(i)},${yAt(p.y)}`))
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {width > 0 && (
        <svg
          className="chart"
          width={width}
          height={height}
          role="img"
          onMouseLeave={() => {
            setTip(null);
            setHover(null);
          }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const rel = e.clientX - rect.left - pad.left;
            const idx = Math.max(
              0,
              Math.min(points.length - 1, Math.round((rel / Math.max(1, plotW)) * (points.length - 1)))
            );
            const point = points[idx];
            setHover(idx);
            setTip({
              x: e.clientX,
              y: e.clientY,
              title: point.x,
              rows: [{ label, value: point.y === null ? 'not ranked' : format(point.y), color }],
            });
          }}
        >
          {[lo, (lo + hi) / 2, hi].map((tick, i) => (
            <g key={i}>
              <line x1={pad.left} x2={width - pad.right} y1={yAt(tick)} y2={yAt(tick)} stroke="var(--grid)" />
              <text x={pad.left - 6} y={yAt(tick) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {format(Math.round(tick))}
              </text>
            </g>
          ))}

          {hover !== null && (
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke="var(--line-strong)"
              strokeWidth="1"
            />
          )}

          <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {points.map((p, i) =>
            p.y === null ? null : (
              <circle
                key={i}
                cx={xAt(i)}
                cy={yAt(p.y)}
                r={hover === i ? 5 : 3.5}
                fill={color}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            )
          )}

          {points.length > 0 && (
            <>
              <text x={pad.left} y={height - 6} fontSize="10" fill="var(--text-muted)">
                {points[0].x}
              </text>
              <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {points[points.length - 1].x}
              </text>
            </>
          )}
        </svg>
      )}
      <Tooltip state={tip} />
    </div>
  );
}

/** Single 0-100 score as a ring. A hero number, not a pie of many parts. */
export function ScoreRing({
  score,
  size = 74,
  label,
}: {
  score: number;
  size?: number;
  label?: string;
}) {
  const stroke = 7;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped >= 80 ? 'var(--good)' : clamped >= 55 ? 'var(--warning)' : 'var(--critical)';

  return (
    <div className="score-ring" style={{ width: size, height: size }} title={`${score} / 100`}>
      <svg width={size} height={size} role="img" aria-label={`${label ?? 'Score'}: ${score} out of 100`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-sunken)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="score-num">{Math.round(score)}</span>
    </div>
  );
}

/** Compact trend bars for a stat tile. */
export function Sparkbars({
  values,
  height = 30,
  color = 'var(--series-1)',
}: {
  values: number[];
  height?: number;
  color?: string;
}) {
  const max = Math.max(1, ...values.map(Math.abs));
  return (
    <div className="row" style={{ gap: 2, height, alignItems: 'flex-end' }}>
      {values.map((value, i) => (
        <div
          key={i}
          title={String(value)}
          style={{
            flex: 1,
            minWidth: 3,
            height: `${Math.max(6, (Math.abs(value) / max) * 100)}%`,
            background: color,
            opacity: i === values.length - 1 ? 1 : 0.45,
            borderRadius: '3px 3px 1px 1px',
          }}
        />
      ))}
    </div>
  );
}
