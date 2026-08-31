import React, { useState } from 'react';
import { api, useApi, type ListResponse } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, Stat, Tabs } from '../components/ui';
import { BarChart, RankedBars, Sparkbars } from '../components/charts';
import {
  centsToDollars,
  dollarsToCents,
  formatDate,
  formatMonth,
  money,
  moneyShort,
  num,
  today,
} from '../lib/format';

type Client = {
  id: number;
  name: string;
  company: string;
  email: string;
  status: string;
  hourly_rate_cents: number;
  project_count: number;
  open_balance_cents: number;
  lifetime_cents: number;
};

type Invoice = {
  id: number;
  number: string;
  client_id: number | null;
  client_name: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  tax_rate: number;
  subtotal_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  overdue: boolean;
};

const STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'];

export function BusinessPage() {
  const [tab, setTab] = useState<'overview' | 'clients' | 'pipeline' | 'invoices' | 'kpis'>('overview');
  const overview = useApi<any>('/business-overview');
  const clients = useApi<ListResponse<Client>>('/clients?archived=0');

  const reload = () => {
    void overview.reload();
    void clients.reload();
  };

  return (
    <>
      <header className="topbar">
        <h1>Business</h1>
        <span className="spacer" />
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        <Tabs
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'clients', label: 'Clients', count: clients.data?.items.length },
            { id: 'pipeline', label: 'Pipeline' },
            { id: 'invoices', label: 'Invoices' },
            { id: 'kpis', label: 'KPIs' },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'overview' && <OverviewTab data={overview.data} />}
        {tab === 'clients' && <ClientsTab clients={clients.data?.items ?? []} onChanged={reload} />}
        {tab === 'pipeline' && <PipelineTab clients={clients.data?.items ?? []} onChanged={reload} />}
        {tab === 'invoices' && <InvoicesTab clients={clients.data?.items ?? []} onChanged={reload} />}
        {tab === 'kpis' && <KpisTab onChanged={reload} />}
      </div>
    </>
  );
}

function OverviewTab({ data }: { data: any }) {
  if (!data) return <div className="muted">Loading…</div>;
  const byMonth = data.revenue.by_month ?? [];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid cols-4">
        <Card><Stat label="Collected YTD" value={moneyShort(data.revenue.collected_ytd_cents)} sub={`${moneyShort(data.revenue.collected_mtd_cents)} this month`} /></Card>
        <Card>
          <Stat
            label="Outstanding"
            value={moneyShort(data.receivables.outstanding_cents)}
            sub={`${data.receivables.count} unpaid invoice(s)`}
          />
        </Card>
        <Card>
          <Stat
            label="Overdue"
            value={<span className={data.receivables.overdue_cents ? 'neg' : ''}>{moneyShort(data.receivables.overdue_cents)}</span>}
          />
        </Card>
        <Card><Stat label="Active clients" value={num(data.clients.active)} sub={`${data.clients.total} total`} /></Card>
      </div>

      <div className="grid sidebar-right">
        <Card title="Revenue collected">
          {byMonth.length ? (
            <BarChart
              categories={byMonth.map((r: any) => formatMonth(r.month))}
              series={[{ label: 'Collected', values: byMonth.map((r: any) => r.cents / 100) }]}
              format={(v) => moneyShort(v * 100)}
            />
          ) : (
            <Empty icon="◫" title="No payments yet" />
          )}
        </Card>

        <Card title="Top clients by revenue">
          {(data.clients.top ?? []).length ? (
            <RankedBars
              items={data.clients.top.map((c: any) => ({ label: c.name, value: c.revenue_cents / 100 }))}
              format={(v) => moneyShort(v * 100)}
            />
          ) : (
            <Empty icon="◫" title="No revenue yet" />
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Awaiting payment">
          {(data.receivables.invoices ?? []).length ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th className="right">Balance</th></tr></thead>
                <tbody>
                  {data.receivables.invoices.map((inv: any) => (
                    <tr key={inv.id}>
                      <td>{inv.number}</td>
                      <td className="truncate">{inv.client_name}</td>
                      <td className={inv.due_date && inv.due_date < today() ? 'neg' : 'muted'}>
                        {inv.due_date ? formatDate(inv.due_date) : '—'}
                      </td>
                      <td className="right">{money(inv.balance_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="✓" title="Nothing outstanding" />
          )}
        </Card>

        <Card title="KPIs">
          {(data.metrics ?? []).length ? (
            <div className="stack">
              {data.metrics.map((metric: any) => {
                const history = (metric.history ?? []).slice().reverse();
                const latest = metric.latest?.value ?? 0;
                const display =
                  metric.unit === 'currency' ? moneyShort(latest * 100) : metric.unit === 'percent' ? `${latest}%` : num(latest);
                return (
                  <div key={metric.id} className="row between" style={{ gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="small muted truncate">{metric.label}</div>
                      <strong>{display}</strong>
                      {metric.target ? (
                        <span className="small muted">
                          {' '}/{' '}
                          {metric.unit === 'currency'
                            ? moneyShort(metric.target * 100)
                            : metric.unit === 'percent'
                              ? `${metric.target}%`
                              : num(metric.target)}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ width: 90 }}>
                      <Sparkbars values={history.map((h: any) => h.value)} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty icon="◈" title="No KPIs tracked" />
          )}
        </Card>
      </div>
    </div>
  );
}

function ClientsTab({ clients, onChanged }: { clients: Client[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', company: '', email: '', phone: '', status: 'active', rate: '0' });
  const [error, setError] = useState('');

  return (
    <Card title="Clients" actions={<button className="btn sm" onClick={() => setAdding(true)}>+ Client</button>} padded={false}>
      {clients.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Name</th><th>Company</th><th>Status</th><th className="right">Projects</th><th className="right">Open balance</th><th className="right">Lifetime</th><th></th></tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}<div className="small muted">{c.email}</div></td>
                  <td className="muted">{c.company || '—'}</td>
                  <td><Chip tone={c.status === 'active' ? 'good' : ''}>{c.status}</Chip></td>
                  <td className="right">{c.project_count}</td>
                  <td className="right">{money(c.open_balance_cents)}</td>
                  <td className="right">{money(c.lifetime_cents)}</td>
                  <td className="right">
                    <ConfirmButton onConfirm={async () => { await api.del(`/clients/${c.id}`); onChanged(); }}>
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="◫" title="No clients yet" />
      )}

      {adding && (
        <Modal
          title="New client"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!form.name.trim()}
                onClick={async () => {
                  try {
                    await api.post('/clients', { ...form, hourly_rate_cents: dollarsToCents(form.rate) });
                    setAdding(false);
                    setForm({ name: '', company: '', email: '', phone: '', status: 'active', rate: '0' });
                    onChanged();
                  } catch (err: any) {
                    setError(err?.message ?? 'Could not save');
                  }
                }}
              >
                Add
              </button>
            </>
          }
        >
          <Banner tone="error">{error}</Banner>
          <Field label="Name"><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="field-row">
            <Field label="Company"><input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          </div>
          <div className="field-row">
            <Field label="Status">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {['active', 'prospect', 'churned'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Hourly rate">
              <input inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function PipelineTab({ clients, onChanged }: { clients: Client[]; onChanged: () => void }) {
  const pipeline = useApi<any>('/pipeline');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', client_id: '', value: '', stage: 'lead', probability: 25, expected_close: '' });

  const data = pipeline.data;
  const reload = () => {
    void pipeline.reload();
    onChanged();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid cols-3">
        <Card><Stat label="Open pipeline" value={moneyShort(data?.open_value_cents ?? 0)} /></Card>
        <Card><Stat label="Weighted" value={moneyShort(data?.weighted_open_cents ?? 0)} sub="by probability" /></Card>
        <Card><Stat label="Won this year" value={moneyShort(data?.won_this_year_cents ?? 0)} /></Card>
      </div>

      <div className="row">
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>+ Deal</button>
      </div>

      <div className="board">
        {(data?.stages ?? []).map((stage: any) => (
          <div className="board-col" key={stage.stage}>
            <div className="board-col-head">
              {stage.stage}
              <span className="muted">{stage.count}</span>
              <span className="spacer" />
              <span className="muted tabular">{moneyShort(stage.value_cents)}</span>
            </div>
            {stage.deals.map((deal: any) => (
              <div className="task-card" key={deal.id} draggable={false}>
                <div className="title">{deal.title}</div>
                <div className="meta">
                  <span>{deal.client_name || 'No client'}</span>
                  <span className="spacer" />
                  <strong>{moneyShort(deal.value_cents)}</strong>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <select
                    value={deal.stage}
                    onChange={async (e) => {
                      await api.patch(`/deals/${deal.id}`, { stage: e.target.value });
                      reload();
                    }}
                    style={{ fontSize: 12, padding: '3px 5px' }}
                  >
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span className="small muted">{deal.probability}%</span>
                </div>
              </div>
            ))}
            {!stage.deals.length && <div className="small muted" style={{ padding: 6 }}>Empty</div>}
          </div>
        ))}
      </div>

      {adding && (
        <Modal
          title="New deal"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!form.title.trim()}
                onClick={async () => {
                  await api.post('/deals', {
                    title: form.title,
                    client_id: form.client_id ? Number(form.client_id) : null,
                    value_cents: dollarsToCents(form.value),
                    stage: form.stage,
                    probability: form.probability,
                    expected_close: form.expected_close || null,
                  });
                  setAdding(false);
                  setForm({ title: '', client_id: '', value: '', stage: 'lead', probability: 25, expected_close: '' });
                  reload();
                }}
              >
                Add
              </button>
            </>
          }
        >
          <Field label="Title"><input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <div className="field-row">
            <Field label="Client">
              <select value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
                <option value="">None</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Value">
              <input inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Stage">
              <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Probability %">
              <input type="number" min={0} max={100} value={form.probability} onChange={(e) => setForm({ ...form, probability: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Expected close">
            <input type="date" value={form.expected_close} onChange={(e) => setForm({ ...form, expected_close: e.target.value })} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function InvoicesTab({ clients, onChanged }: { clients: Client[]; onChanged: () => void }) {
  const invoices = useApi<ListResponse<Invoice>>('/invoices?limit=200');
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const items = invoices.data?.items ?? [];
  const reload = () => {
    void invoices.reload();
    onChanged();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ Invoice</button>
      </div>

      <Card padded={false}>
        {items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Number</th><th>Client</th><th>Status</th><th>Issued</th><th>Due</th><th className="right">Total</th><th className="right">Balance</th></tr>
              </thead>
              <tbody>
                {items.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <button
                        onClick={() => setOpen(inv.id)}
                        style={{ background: 'none', border: 'none', font: 'inherit', color: 'var(--accent-ink)', cursor: 'pointer', padding: 0 }}
                      >
                        {inv.number}
                      </button>
                    </td>
                    <td className="truncate">{inv.client_name || '—'}</td>
                    <td>
                      <Chip tone={inv.status === 'paid' ? 'good' : inv.overdue ? 'critical' : inv.status === 'sent' ? 'accent' : ''}>
                        {inv.overdue ? 'overdue' : inv.status}
                      </Chip>
                    </td>
                    <td className="small muted">{formatDate(inv.issue_date)}</td>
                    <td className="small muted">{inv.due_date ? formatDate(inv.due_date) : '—'}</td>
                    <td className="right">{money(inv.total_cents)}</td>
                    <td className="right">{money(inv.balance_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="◫" title="No invoices" hint="Create one and bill tracked time straight onto it." />
        )}
      </Card>

      {creating && (
        <Modal
          title="New invoice"
          onClose={() => setCreating(false)}
          footer={<span className="small muted">The number is assigned automatically.</span>}
        >
          <div className="stack">
            {clients.map((c) => (
              <button
                key={c.id}
                className="btn"
                onClick={async () => {
                  const created = await api.post<Invoice>('/invoices', {
                    client_id: c.id,
                    issue_date: today(),
                  });
                  setCreating(false);
                  setOpen(created.id);
                  reload();
                }}
              >
                Invoice {c.name}
              </button>
            ))}
            {!clients.length && <Empty icon="◫" title="Add a client first" />}
          </div>
        </Modal>
      )}

      {open !== null && (
        <InvoiceDetail invoiceId={open} onClose={() => setOpen(null)} onChanged={reload} />
      )}
    </div>
  );
}

function InvoiceDetail({ invoiceId, onClose, onChanged }: { invoiceId: number; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = useApi<any>(`/invoices/${invoiceId}/full`, [invoiceId]);
  const projects = useApi<ListResponse<any>>('/projects?archived=0');
  const accounts = useApi<ListResponse<any>>('/accounts?archived=0');
  const [item, setItem] = useState({ description: '', quantity: '1', unit: '' });
  const [payment, setPayment] = useState({ amount: '', account_id: '' });
  const [error, setError] = useState('');

  if (!data) return null;
  const refresh = () => {
    void reload();
    onChanged();
  };

  return (
    <Modal
      title={`Invoice ${data.number}`}
      wide
      onClose={onClose}
      footer={
        <>
          <ConfirmButton
            className="btn danger"
            onConfirm={async () => {
              await api.del(`/invoices/${invoiceId}`);
              onChanged();
              onClose();
            }}
          >
            Delete
          </ConfirmButton>
          <span className="spacer" />
          {data.status === 'draft' && (
            <button
              className="btn primary"
              onClick={async () => {
                await api.post(`/invoices/${invoiceId}/send`);
                refresh();
              }}
            >
              Mark as sent
            </button>
          )}
        </>
      }
    >
      <Banner tone="error">{error}</Banner>

      <div className="grid cols-4">
        <Stat label="Subtotal" value={money(data.subtotal_cents)} small />
        <Stat label={`Tax (${data.tax_rate}%)`} value={money(data.tax_cents)} small />
        <Stat label="Total" value={money(data.total_cents)} small />
        <Stat
          label="Balance"
          value={<span className={data.balance_cents > 0 ? 'neg' : 'pos'}>{money(data.balance_cents)}</span>}
          small
        />
      </div>

      <div>
        <h3>Line items</h3>
        <table className="data">
          <thead><tr><th>Description</th><th className="right">Qty</th><th className="right">Unit</th><th className="right">Amount</th><th></th></tr></thead>
          <tbody>
            {data.items.map((line: any) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td className="right">{line.quantity}</td>
                <td className="right">{money(line.unit_cents)}</td>
                <td className="right">{money(Math.round(line.quantity * line.unit_cents))}</td>
                <td className="right">
                  <ConfirmButton
                    onConfirm={async () => {
                      await api.del(`/invoice-items/${line.id}`);
                      refresh();
                    }}
                  >
                    ✕
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <Field label="Description">
            <input value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} />
          </Field>
          <Field label="Qty">
            <input value={item.quantity} onChange={(e) => setItem({ ...item, quantity: e.target.value })} style={{ width: 70 }} />
          </Field>
          <Field label="Unit price">
            <input value={item.unit} onChange={(e) => setItem({ ...item, unit: e.target.value })} style={{ width: 100 }} />
          </Field>
          <button
            className="btn"
            disabled={!item.description.trim()}
            onClick={async () => {
              await api.post('/invoice-items', {
                invoice_id: invoiceId,
                description: item.description,
                quantity: Number(item.quantity) || 1,
                unit_cents: dollarsToCents(item.unit),
              });
              setItem({ description: '', quantity: '1', unit: '' });
              refresh();
            }}
          >
            Add
          </button>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <select id="bill-project" defaultValue="" style={{ width: 220 }}>
            <option value="">Bill tracked time from…</option>
            {(projects.data?.items ?? []).filter((p: any) => p.billable).map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            className="btn"
            onClick={async () => {
              const select = document.getElementById('bill-project') as HTMLSelectElement | null;
              const projectId = Number(select?.value);
              if (!projectId) return;
              try {
                const res = await api.post<any>(`/invoices/${invoiceId}/bill-time`, { project_id: projectId });
                if (!res.added) setError('No unbilled billable time on that project.');
                refresh();
              } catch (err: any) {
                setError(err?.message ?? 'Could not bill time');
              }
            }}
          >
            Add time
          </button>
        </div>
      </div>

      <div>
        <h3>Payments</h3>
        {data.payments.map((p: any) => (
          <div className="task-row" key={p.id}>
            <span className="title">{formatDate(p.paid_on)} · {p.method || 'payment'}</span>
            <strong className="tabular">{money(p.amount_cents)}</strong>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <Field label="Amount">
            <input
              inputMode="decimal"
              value={payment.amount}
              onChange={(e) => setPayment({ ...payment, amount: e.target.value })}
              placeholder={centsToDollars(data.balance_cents)}
              style={{ width: 110 }}
            />
          </Field>
          <Field label="Deposit into">
            <select value={payment.account_id} onChange={(e) => setPayment({ ...payment, account_id: e.target.value })} style={{ width: 180 }}>
              <option value="">Don't record in budget</option>
              {(accounts.data?.items ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <button
            className="btn primary"
            onClick={async () => {
              const cents = payment.amount ? dollarsToCents(payment.amount) : data.balance_cents;
              if (!cents) return;
              await api.post(`/invoices/${invoiceId}/payments`, {
                amount_cents: cents,
                account_id: payment.account_id ? Number(payment.account_id) : undefined,
              });
              setPayment({ amount: '', account_id: '' });
              refresh();
            }}
          >
            Record payment
          </button>
        </div>
      </div>
    </Modal>
  );
}

function KpisTab({ onChanged }: { onChanged: () => void }) {
  const metrics = useApi<ListResponse<any>>('/metrics');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ key: '', label: '', unit: 'count', target: '', direction: 'up' });

  const items = metrics.data?.items ?? [];
  const reload = () => {
    void metrics.reload();
    onChanged();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>+ KPI</button>
      </div>

      {items.length ? (
        <div className="grid cols-2">
          {items.map((metric: any) => {
            const values = (metric.values ?? []).slice().reverse();
            return (
              <Card key={metric.id} title={metric.label}>
                <div className="row between" style={{ alignItems: 'flex-end' }}>
                  <Stat
                    label={metric.unit}
                    value={
                      metric.unit === 'currency'
                        ? moneyShort((values[values.length - 1]?.value ?? 0) * 100)
                        : num(values[values.length - 1]?.value ?? 0, 2)
                    }
                    sub={metric.target ? `target ${metric.target}` : undefined}
                    small
                  />
                  <div style={{ width: 130 }}>
                    <Sparkbars values={values.map((v: any) => v.value)} />
                  </div>
                </div>
                <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
                  <Field label="Period">
                    <input type="month" id={`period-${metric.id}`} defaultValue={new Date().toISOString().slice(0, 7)} />
                  </Field>
                  <Field label="Value">
                    <input id={`value-${metric.id}`} inputMode="decimal" style={{ width: 100 }} />
                  </Field>
                  <button
                    className="btn"
                    onClick={async () => {
                      const period = (document.getElementById(`period-${metric.id}`) as HTMLInputElement)?.value;
                      const value = (document.getElementById(`value-${metric.id}`) as HTMLInputElement)?.value;
                      if (!period || value === '') return;
                      await api.put(`/metrics/${metric.id}/values/${period}`, { value: Number(value) });
                      reload();
                    }}
                  >
                    Record
                  </button>
                  <span className="spacer" />
                  <ConfirmButton
                    onConfirm={async () => {
                      await api.del(`/metrics/${metric.id}`);
                      reload();
                    }}
                  >
                    Delete
                  </ConfirmButton>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card><Empty icon="◈" title="No KPIs" hint="Track the numbers that aren't derived from other modules." /></Card>
      )}

      {adding && (
        <Modal
          title="New KPI"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!form.label.trim()}
                onClick={async () => {
                  await api.post('/metrics', {
                    key: form.key || form.label.toLowerCase().replace(/\s+/g, '_'),
                    label: form.label,
                    unit: form.unit,
                    target: form.target ? Number(form.target) : null,
                    direction: form.direction,
                  });
                  setAdding(false);
                  setForm({ key: '', label: '', unit: 'count', target: '', direction: 'up' });
                  reload();
                }}
              >
                Add
              </button>
            </>
          }
        >
          <Field label="Label"><input autoFocus value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
          <div className="field-row">
            <Field label="Unit">
              <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                {['count', 'currency', 'percent'].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Target"><input inputMode="decimal" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} /></Field>
          </div>
          <Field label="Good direction">
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
              <option value="up">Higher is better</option>
              <option value="down">Lower is better</option>
            </select>
          </Field>
        </Modal>
      )}
    </div>
  );
}
