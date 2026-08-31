import React, { useEffect, useRef, useState } from 'react';

export function Card({
  title,
  actions,
  children,
  className = '',
  padded = true,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`card ${padded ? '' : 'pad-0'} ${className}`}>
      {(title || actions) && (
        <div className="card-head" style={padded ? undefined : { padding: '14px 16px 0' }}>
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  delta,
  small,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  delta?: { value: number; suffix?: string; goodWhenUp?: boolean };
  small?: boolean;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${small ? 'sm' : ''}`}>{value}</span>
      {delta !== undefined && <DeltaBadge {...delta} />}
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function DeltaBadge({
  value,
  suffix = '',
  goodWhenUp = true,
}: {
  value: number;
  suffix?: string;
  goodWhenUp?: boolean;
}) {
  if (!value) return <span className="delta flat">no change</span>;
  const up = value > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`delta ${good ? 'up' : 'down'}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

export function Chip({
  children,
  tone = '',
  color,
}: {
  children: React.ReactNode;
  tone?: '' | 'good' | 'warning' | 'serious' | 'critical' | 'accent';
  color?: string;
}) {
  return (
    <span className={`chip ${tone}`}>
      {color && <span className="dot" style={{ background: color, color }} />}
      {children}
    </span>
  );
}

export function Empty({ icon = '◌', title, hint }: { icon?: string; title: string; hint?: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{title}</div>
      {hint && <div className="small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2 style={{ marginRight: 'auto' }}>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="small muted">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`tab ${active === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="muted"> {tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Banner({ tone = '', children }: { tone?: '' | 'error' | 'ok'; children: React.ReactNode }) {
  if (!children) return null;
  return <div className={`banner ${tone}`}>{children}</div>;
}

export function ProgressBar({ percent, tone }: { percent: number; tone?: 'over' | 'warn' }) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className="bar-track" title={`${Math.round(percent)}%`}>
      <div className={`bar-fill ${tone ?? ''}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/** Confirm-then-run, so destructive actions need two clicks rather than a dialog. */
export function ConfirmButton({
  onConfirm,
  children,
  className = 'btn sm danger',
  confirmLabel = 'Sure?',
}: {
  onConfirm: () => void;
  children: React.ReactNode;
  className?: string;
  confirmLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number>();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      className={className}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          timer.current = window.setTimeout(() => setArmed(false), 3500);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

/** Measures a container so charts can render at real pixel size (crisp text). */
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
