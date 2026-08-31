import React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { Card, Chip, Empty, Stat } from '../components/ui';
import { BarChart, Legend, SERIES } from '../components/charts';
import {
  formatDate,
  formatDateTime,
  formatMonth,
  minutesToHours,
  money,
  moneyShort,
  num,
  relativeDay,
} from '../lib/format';

type Dash = {
  generated_at: string;
  alerts: Array<{ severity: 'critical' | 'warning' | 'info'; module: string; message: string; link: string }>;
  money: {
    net_worth_cents: number;
    liquid_cents: number;
    income_mtd_cents: number;
    expense_mtd_cents: number;
    cashflow: Array<{ month: string; income_cents: number; expense_cents: number }>;
  };
  work: {
    open_tasks: number;
    due_today: number;
    overdue: number;
    completed_this_week: number;
    hours_this_week: number;
    active_projects: number;
    next: Array<any>;
    running_timer: any;
  };
  revenue: {
    collected_mtd_cents: number;
    collected_ytd_cents: number;
    outstanding_cents: number;
    pipeline_weighted_cents: number;
    by_month: Array<{ month: string; cents: number }>;
  };
  social: {
    scheduled: number;
    next_7_days: number;
    published_30d: number;
    needs_attention: number;
    upcoming: Array<{ id: number; body: string; scheduled_at: string }>;
  };
  seo: {
    sites: number;
    tracked_keywords: number;
    avg_health: number;
    top3: number;
    ai_citations: number;
  };
  activity: Array<{ entity_type: string; action: string; summary: string; created_at: string }>;
};

export function Dashboard() {
  const { data, loading } = useApi<Dash>('/dashboard');

  if (loading && !data) return <div className="page muted">Loading…</div>;
  if (!data) return <div className="page muted">No data.</div>;

  const cashflow = data.money.cashflow;
  const netMtd = data.money.income_mtd_cents - data.money.expense_mtd_cents;

  return (
    <>
      <header className="topbar">
        <h1>Dashboard</h1>
        <span className="spacer" />
        <span className="small muted">Updated {formatDateTime(data.generated_at)}</span>
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        {data.alerts.length > 0 && (
          <Card title={`Needs attention (${data.alerts.length})`}>
            {data.alerts.map((alert, i) => (
              <div className="alert-row" key={i}>
                <span className={`alert-dot ${alert.severity}`} aria-hidden="true" />
                <span style={{ flex: 1 }}>{alert.message}</span>
                <Link className="btn sm ghost" to={alert.link}>
                  Open
                </Link>
              </div>
            ))}
          </Card>
        )}

        <div className="grid cols-4">
          <Card>
            <Stat
              label="Net worth"
              value={moneyShort(data.money.net_worth_cents)}
              sub={`${moneyShort(data.money.liquid_cents)} liquid`}
            />
          </Card>
          <Card>
            <Stat
              label="Net this month"
              value={<span className={netMtd >= 0 ? 'pos' : 'neg'}>{moneyShort(netMtd)}</span>}
              sub={`${moneyShort(data.money.income_mtd_cents)} in · ${moneyShort(data.money.expense_mtd_cents)} out`}
            />
          </Card>
          <Card>
            <Stat
              label="Collected YTD"
              value={moneyShort(data.revenue.collected_ytd_cents)}
              sub={`${moneyShort(data.revenue.outstanding_cents)} outstanding`}
            />
          </Card>
          <Card>
            <Stat
              label="Open tasks"
              value={num(data.work.open_tasks)}
              sub={
                data.work.overdue > 0 ? (
                  <span className="neg">{data.work.overdue} overdue</span>
                ) : (
                  `${data.work.due_today} due today`
                )
              }
            />
          </Card>
        </div>

        <div className="grid sidebar-right">
          <Card
            title="Cash in and out"
            actions={
              <Legend
                items={[
                  { label: 'Income', color: SERIES[0] },
                  { label: 'Expenses', color: SERIES[1] },
                ]}
              />
            }
          >
            {cashflow.length ? (
              <BarChart
                categories={cashflow.map((c) => formatMonth(c.month))}
                series={[
                  { label: 'Income', values: cashflow.map((c) => c.income_cents / 100) },
                  { label: 'Expenses', values: cashflow.map((c) => c.expense_cents / 100) },
                ]}
                format={(v) => moneyShort(v * 100)}
              />
            ) : (
              <Empty icon="▤" title="No transactions yet" hint="Add an account and import a statement." />
            )}
          </Card>

          <Card title="This week">
            <div className="stack">
              <Stat small label="Tracked" value={`${data.work.hours_this_week}h`} />
              <Stat small label="Completed" value={num(data.work.completed_this_week)} />
              <Stat small label="Active projects" value={num(data.work.active_projects)} />
              {data.work.running_timer && (
                <div className="banner ok">
                  Timer running since {formatDateTime(data.work.running_timer.started_at)}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="grid cols-3">
          <Card title="Coming up">
            {data.work.next.length ? (
              <div>
                {data.work.next.map((task) => (
                  <div className="task-row" key={task.id}>
                    <span className={`prio prio-${task.priority}`} style={{ height: 22 }} />
                    <span className="title truncate">{task.title}</span>
                    <span
                      className={`small ${task.due_date < new Date().toISOString().slice(0, 10) ? 'neg' : 'muted'}`}
                    >
                      {relativeDay(task.due_date)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="☑" title="Nothing scheduled" hint={<Link to="/tasks">Add a task</Link>} />
            )}
          </Card>

          <Card title="Social queue">
            <div className="row wrap" style={{ gap: 14, marginBottom: 10 }}>
              <Stat small label="Scheduled" value={num(data.social.scheduled)} />
              <Stat small label="Next 7 days" value={num(data.social.next_7_days)} />
              <Stat small label="Published 30d" value={num(data.social.published_30d)} />
            </div>
            {data.social.needs_attention > 0 && (
              <div className="banner error" style={{ marginBottom: 10 }}>
                {data.social.needs_attention} post target(s) need attention
              </div>
            )}
            {data.social.upcoming.length ? (
              data.social.upcoming.map((post) => (
                <div className="task-row" key={post.id}>
                  <span className="title truncate small">{post.body}</span>
                  <span className="small muted">{formatDate(post.scheduled_at)}</span>
                </div>
              ))
            ) : (
              <Empty icon="◇" title="Queue is empty" hint={<Link to="/social">Compose a post</Link>} />
            )}
          </Card>

          <Card title="Search visibility">
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Stat small label="Site health" value={data.seo.avg_health || '—'} sub="avg score" />
              <Stat small label="Keywords" value={num(data.seo.tracked_keywords)} sub="tracked" />
              <Stat small label="Top 3" value={num(data.seo.top3)} sub="positions" />
              <Stat small label="AI answers" value={num(data.seo.ai_citations)} sub="citations" />
            </div>
            <div style={{ marginTop: 10 }}>
              <Link className="btn sm" to="/seo">
                Open SEO & AEO
              </Link>
            </div>
          </Card>
        </div>

        <div className="grid sidebar-right">
          <Card
            title="Revenue collected"
            actions={<Chip tone="accent">{moneyShort(data.revenue.pipeline_weighted_cents)} weighted pipeline</Chip>}
          >
            {data.revenue.by_month.length ? (
              <BarChart
                categories={data.revenue.by_month.map((r) => formatMonth(r.month))}
                series={[{ label: 'Collected', values: data.revenue.by_month.map((r) => r.cents / 100) }]}
                format={(v) => moneyShort(v * 100)}
              />
            ) : (
              <Empty icon="◫" title="No payments recorded" hint={<Link to="/business">Create an invoice</Link>} />
            )}
          </Card>

          <Card title="Recent activity">
            {data.activity.length ? (
              <div className="stack" style={{ gap: 7 }}>
                {data.activity.slice(0, 10).map((item, i) => (
                  <div key={i} className="small">
                    <span className="muted">{item.action}</span>{' '}
                    <span className="truncate">{item.summary || item.entity_type}</span>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {formatDateTime(item.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="◌" title="Nothing yet" />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
