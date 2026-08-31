import React, { useState } from 'react';
import { api, qs, useApi, type ListResponse } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, ProgressBar, Stat, Tabs } from '../components/ui';
import { BarChart, Legend, RankedBars, SERIES } from '../components/charts';
import {
  centsToDollars,
  dollarsToCents,
  formatDate,
  formatMonth,
  money,
  moneyShort,
  monthKey,
  num,
  shiftMonth,
  today,
} from '../lib/format';

type Account = {
  id: number;
  name: string;
  type: string;
  institution: string;
  business: number;
  archived: number;
  opening_cents: number;
  balance_cents: number;
  transaction_count: number;
};

type Category = { id: number; name: string; kind: 'income' | 'expense'; color: string; business: number };

type Txn = {
  id: number;
  account_id: number;
  category_id: number | null;
  txn_date: string;
  amount_cents: number;
  payee: string;
  memo: string;
  cleared: number;
  business: number;
  source: string;
  account_name: string;
  category_name: string;
};

const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'cash', 'investment', 'loan'];

export function BudgetPage() {
  const [tab, setTab] = useState<'overview' | 'transactions' | 'envelopes' | 'accounts'>('overview');
  const overview = useApi<any>('/budget-overview?months=6');
  const accounts = useApi<ListResponse<Account>>('/accounts');
  const categories = useApi<ListResponse<Category>>('/categories?archived=0&limit=200');

  const reload = () => {
    void overview.reload();
    void accounts.reload();
    void categories.reload();
  };

  return (
    <>
      <header className="topbar">
        <h1>Budget</h1>
        <span className="spacer" />
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        <Tabs
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'transactions', label: 'Transactions' },
            { id: 'envelopes', label: 'Envelopes' },
            { id: 'accounts', label: 'Accounts', count: accounts.data?.items.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'overview' && <OverviewTab data={overview.data} />}
        {tab === 'transactions' && (
          <TransactionsTab
            accounts={accounts.data?.items ?? []}
            categories={categories.data?.items ?? []}
            onChanged={reload}
          />
        )}
        {tab === 'envelopes' && <EnvelopesTab categories={categories.data?.items ?? []} onChanged={reload} />}
        {tab === 'accounts' && <AccountsTab accounts={accounts.data?.items ?? []} onChanged={reload} />}
      </div>
    </>
  );
}

function OverviewTab({ data }: { data: any }) {
  if (!data) return <div className="muted">Loading…</div>;

  const cashflow = data.cashflow ?? [];
  const latest = cashflow[cashflow.length - 1];
  const net = latest ? latest.income_cents - latest.expense_cents : 0;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid cols-4">
        <Card><Stat label="Net worth" value={moneyShort(data.net_worth_cents)} /></Card>
        <Card><Stat label="Assets" value={moneyShort(data.assets_cents)} /></Card>
        <Card>
          <Stat label="Liabilities" value={moneyShort(Math.abs(data.liabilities_cents))} />
        </Card>
        <Card>
          <Stat
            label="Net this month"
            value={<span className={net >= 0 ? 'pos' : 'neg'}>{moneyShort(net)}</span>}
            sub={data.uncategorized ? `${data.uncategorized} uncategorised` : 'all categorised'}
          />
        </Card>
      </div>

      <div className="grid sidebar-right">
        <Card
          title="Cashflow"
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
              categories={cashflow.map((c: any) => formatMonth(c.month))}
              series={[
                { label: 'Income', values: cashflow.map((c: any) => c.income_cents / 100) },
                { label: 'Expenses', values: cashflow.map((c: any) => c.expense_cents / 100) },
              ]}
              format={(v) => moneyShort(v * 100)}
            />
          ) : (
            <Empty icon="▤" title="No transactions yet" />
          )}
        </Card>

        <Card title="Spending this month">
          {(data.by_category ?? []).length ? (
            <RankedBars
              items={data.by_category.map((c: any) => ({
                label: c.category,
                value: c.spent_cents / 100,
                color: c.color,
              }))}
              format={(v) => money(v * 100)}
            />
          ) : (
            <Empty icon="▤" title="Nothing spent yet" />
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Accounts">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Account</th><th>Type</th><th className="right">Balance</th></tr></thead>
              <tbody>
                {(data.accounts ?? []).map((a: Account) => (
                  <tr key={a.id}>
                    <td>{a.name}{a.business ? <Chip>business</Chip> : null}</td>
                    <td className="muted">{a.type}</td>
                    <td className="right">
                      <span className={a.balance_cents < 0 ? 'neg' : ''}>{money(a.balance_cents)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Upcoming bills">
            {(data.upcoming ?? []).length ? (
              (data.upcoming ?? []).map((r: any) => (
                <div className="task-row" key={r.id}>
                  <span className="title truncate">{r.payee}</span>
                  <span className="small muted">{formatDate(r.next_date)}</span>
                  <strong className="tabular">{money(r.amount_cents)}</strong>
                </div>
              ))
            ) : (
              <Empty icon="▤" title="No recurring bills" />
            )}
          </Card>

          <Card title="Savings goals">
            {(data.goals ?? []).length ? (
              <div className="stack">
                {(data.goals ?? []).map((g: any) => (
                  <div key={g.id}>
                    <div className="row between small">
                      <span>{g.name}</span>
                      <span className="tabular">{money(g.saved_cents)} / {money(g.target_cents)}</span>
                    </div>
                    <ProgressBar percent={g.percent} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="◎" title="No goals set" />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function TransactionsTab({
  accounts,
  categories,
  onChanged,
}: {
  accounts: Account[];
  categories: Category[];
  onChanged: () => void;
}) {
  const [filters, setFilters] = useState({ account_id: '', category_id: '', q: '', uncategorized: '' });
  const path = `/transactions${qs({ ...filters, limit: 300 })}`;
  const txns = useApi<ListResponse<Txn>>(path, [path]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const items = txns.data?.items ?? [];
  const reload = () => {
    void txns.reload();
    onChanged();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card>
        <div className="row wrap">
          <select value={filters.account_id} onChange={(e) => setFilters({ ...filters, account_id: e.target.value })} style={{ width: 170 }}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={filters.category_id} onChange={(e) => setFilters({ ...filters, category_id: e.target.value })} style={{ width: 170 }}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input
            placeholder="Search payee or memo…"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            style={{ width: 200 }}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={filters.uncategorized === '1'}
              onChange={(e) => setFilters({ ...filters, uncategorized: e.target.checked ? '1' : '' })}
            />
            Uncategorised only
          </label>
          <span className="spacer" />
          <button className="btn" onClick={() => setTransferring(true)}>Transfer</button>
          <button className="btn" onClick={() => setImporting(true)}>Import CSV</button>
          <button className="btn primary" onClick={() => setAdding(true)}>+ Transaction</button>
        </div>
      </Card>

      <Card padded={false}>
        {items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th><th>Payee</th><th>Category</th><th>Account</th>
                  <th className="right">Amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td className="small muted">{formatDate(t.txn_date)}</td>
                    <td>
                      {t.payee || <span className="muted">—</span>}
                      {t.memo && <div className="small muted truncate">{t.memo}</div>}
                    </td>
                    <td>
                      <select
                        value={String(t.category_id ?? '')}
                        onChange={async (e) => {
                          await api.patch(`/transactions/${t.id}`, {
                            category_id: e.target.value ? Number(e.target.value) : null,
                          });
                          reload();
                        }}
                        style={{ width: 150 }}
                      >
                        <option value="">Uncategorised</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td className="small muted">{t.account_name}</td>
                    <td className="right">
                      <span className={t.amount_cents < 0 ? '' : 'pos'}>{money(t.amount_cents)}</span>
                    </td>
                    <td className="right">
                      <ConfirmButton
                        onConfirm={async () => {
                          await api.del(`/transactions/${t.id}`);
                          reload();
                        }}
                      >
                        ✕
                      </ConfirmButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="▤" title="No transactions" hint="Add one by hand or import a bank CSV." />
        )}
      </Card>

      {adding && (
        <TransactionForm
          accounts={accounts}
          categories={categories}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); }}
        />
      )}
      {importing && (
        <ImportForm accounts={accounts} onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />
      )}
      {transferring && (
        <TransferForm accounts={accounts} onClose={() => setTransferring(false)} onSaved={() => { setTransferring(false); reload(); }} />
      )}
    </div>
  );
}

function TransactionForm({
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    txn_date: today(),
    amount: '',
    payee: '',
    memo: '',
    outflow: true,
  });
  const [error, setError] = useState('');

  return (
    <Modal
      title="New transaction"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!form.account_id || !form.amount}
            onClick={async () => {
              try {
                const cents = Math.abs(dollarsToCents(form.amount));
                await api.post('/transactions', {
                  account_id: Number(form.account_id),
                  category_id: form.category_id ? Number(form.category_id) : null,
                  txn_date: form.txn_date,
                  amount_cents: form.outflow ? -cents : cents,
                  payee: form.payee,
                  memo: form.memo,
                });
                onSaved();
              } catch (err: any) {
                setError(err?.message ?? 'Could not save');
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <div className="field-row">
        <Field label="Account">
          <select value={String(form.account_id)} onChange={(e) => setForm({ ...form, account_id: e.target.value as any })}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Amount">
          <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
        </Field>
        <Field label="Direction">
          <select value={form.outflow ? 'out' : 'in'} onChange={(e) => setForm({ ...form, outflow: e.target.value === 'out' })}>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
        </Field>
      </div>
      <Field label="Payee">
        <input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} />
      </Field>
      <Field label="Category">
        <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
          <option value="">Uncategorised</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Memo">
        <input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
      </Field>
    </Modal>
  );
}

function TransferForm({ accounts, onClose, onSaved }: { accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ from: accounts[0]?.id ?? '', to: accounts[1]?.id ?? '', amount: '', date: today() });
  const [error, setError] = useState('');

  return (
    <Modal
      title="Transfer between accounts"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!form.amount || form.from === form.to}
            onClick={async () => {
              try {
                await api.post('/transactions/transfer', {
                  from_account_id: Number(form.from),
                  to_account_id: Number(form.to),
                  amount_cents: Math.abs(dollarsToCents(form.amount)),
                  txn_date: form.date,
                });
                onSaved();
              } catch (err: any) {
                setError(err?.message ?? 'Could not transfer');
              }
            }}
          >
            Transfer
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <div className="field-row">
        <Field label="From">
          <select value={String(form.from)} onChange={(e) => setForm({ ...form, from: e.target.value as any })}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="To">
          <select value={String(form.to)} onChange={(e) => setForm({ ...form, to: e.target.value as any })}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="field-row">
        <Field label="Amount">
          <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="Date">
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
      </div>
      <p className="small muted">Transfers are recorded as a linked pair and excluded from income and expense totals.</p>
    </Modal>
  );
}

function ImportForm({ accounts, onClose, onDone }: { accounts: Account[]; onClose: () => void; onDone: () => void }) {
  const [accountId, setAccountId] = useState(String(accounts[0]?.id ?? ''));
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Import transactions"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
          <button
            className="btn primary"
            disabled={busy || !csv.trim() || !accountId}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const res = await api.post<any>('/transactions/import', {
                  account_id: Number(accountId),
                  csv,
                });
                setResult(res);
                onDone();
              } catch (err: any) {
                setError(err?.message ?? 'Import failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      {result && (
        <Banner tone="ok">
          Imported {result.imported}, skipped {result.skipped} duplicate(s).
          {result.errors?.length ? ` ${result.errors.length} row(s) could not be read.` : ''}
        </Banner>
      )}

      <Field label="Into account">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>

      <Field label="CSV file">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setCsv(await file.text());
          }}
        />
      </Field>

      <Field label="…or paste the CSV" hint="Date, description and amount columns are detected automatically. Re-importing an overlapping export skips duplicates.">
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} style={{ minHeight: 140, fontFamily: 'var(--mono)', fontSize: 12 }} />
      </Field>
    </Modal>
  );
}

function EnvelopesTab({ categories, onChanged }: { categories: Category[]; onChanged: () => void }) {
  const [month, setMonth] = useState(monthKey());
  const budget = useApi<any>(`/budget-month/${month}`, [month]);
  const [addingCategory, setAddingCategory] = useState(false);

  const data = budget.data;
  const expenses = (data?.categories ?? []).filter((c: any) => c.kind === 'expense');

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong style={{ minWidth: 120, textAlign: 'center' }}>{formatMonth(month)}</strong>
          <button className="btn sm" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
          <button
            className="btn sm"
            onClick={async () => {
              await api.post(`/budget-month/${shiftMonth(month, -1)}/copy`, { to: month });
              void budget.reload();
            }}
          >
            Copy last month
          </button>
          <span className="spacer" />
          <button className="btn sm" onClick={() => setAddingCategory(true)}>+ Category</button>
        </div>
      </Card>

      {data && (
        <div className="grid cols-4">
          <Card><Stat label="Budgeted" value={moneyShort(data.totals.budgeted_cents)} /></Card>
          <Card><Stat label="Spent" value={moneyShort(data.totals.spent_cents)} /></Card>
          <Card>
            <Stat
              label="Left to spend"
              value={
                <span className={data.totals.budgeted_cents - data.totals.spent_cents < 0 ? 'neg' : 'pos'}>
                  {moneyShort(data.totals.budgeted_cents - data.totals.spent_cents)}
                </span>
              }
            />
          </Card>
          <Card>
            <Stat
              label="Net income"
              value={<span className={data.totals.net_cents >= 0 ? 'pos' : 'neg'}>{moneyShort(data.totals.net_cents)}</span>}
            />
          </Card>
        </div>
      )}

      <Card title="Envelopes" padded={false}>
        {expenses.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Category</th><th style={{ width: 130 }}>Budgeted</th><th className="right">Spent</th><th style={{ width: 160 }}>Progress</th><th className="right">Remaining</th></tr>
              </thead>
              <tbody>
                {expenses.map((cat: any) => {
                  const pct = cat.percent_used ?? 0;
                  return (
                    <tr key={cat.id}>
                      <td>
                        <span className="row" style={{ gap: 7 }}>
                          <span className="legend-swatch" style={{ background: cat.color }} />
                          {cat.name}
                        </span>
                      </td>
                      <td>
                        <input
                          inputMode="decimal"
                          defaultValue={centsToDollars(cat.budgeted_cents)}
                          onBlur={async (e) => {
                            await api.put(`/budgets/${month}/${cat.id}`, {
                              amount_cents: dollarsToCents(e.target.value),
                            });
                            void budget.reload();
                          }}
                          style={{ width: 110 }}
                        />
                      </td>
                      <td className="right">{money(cat.actual_cents)}</td>
                      <td>
                        {cat.budgeted_cents > 0 ? (
                          <ProgressBar percent={pct} tone={pct > 100 ? 'over' : pct > 85 ? 'warn' : undefined} />
                        ) : (
                          <span className="small muted">not budgeted</span>
                        )}
                      </td>
                      <td className="right">
                        <span className={cat.remaining_cents < 0 ? 'neg' : ''}>{money(cat.remaining_cents)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="▤" title="No categories yet" hint="Add categories to start budgeting." />
        )}
      </Card>

      {addingCategory && (
        <CategoryForm
          onClose={() => setAddingCategory(false)}
          onSaved={() => {
            setAddingCategory(false);
            void budget.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function CategoryForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', kind: 'expense', color: '#2a78d6', business: false });
  const [error, setError] = useState('');

  return (
    <Modal
      title="New category"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!form.name.trim()}
            onClick={async () => {
              try {
                await api.post('/categories', form);
                onSaved();
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
        <Field label="Kind">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </Field>
        <Field label="Colour">
          <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.business} onChange={(e) => setForm({ ...form, business: e.target.checked })} />
        Business category
      </label>
    </Modal>
  );
}

function AccountsTab({ accounts, onChanged }: { accounts: Account[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'checking', institution: '', opening: '0', business: false });
  const [error, setError] = useState('');

  return (
    <Card
      title="Accounts"
      actions={<button className="btn sm" onClick={() => setAdding(true)}>+ Account</button>}
    >
      {accounts.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Institution</th><th className="right">Transactions</th><th className="right">Balance</th><th></th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name} {a.business ? <Chip>business</Chip> : null}</td>
                  <td className="muted">{a.type}</td>
                  <td className="muted">{a.institution || '—'}</td>
                  <td className="right">{num(a.transaction_count)}</td>
                  <td className="right"><span className={a.balance_cents < 0 ? 'neg' : ''}>{money(a.balance_cents)}</span></td>
                  <td className="right">
                    <ConfirmButton
                      onConfirm={async () => {
                        await api.del(`/accounts/${a.id}`);
                        onChanged();
                      }}
                    >
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="▤" title="No accounts" hint="Add a checking account to get started." />
      )}

      {adding && (
        <Modal
          title="New account"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!form.name.trim()}
                onClick={async () => {
                  try {
                    await api.post('/accounts', {
                      name: form.name,
                      type: form.type,
                      institution: form.institution,
                      opening_cents: dollarsToCents(form.opening),
                      business: form.business,
                    });
                    setAdding(false);
                    setForm({ name: '', type: 'checking', institution: '', opening: '0', business: false });
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
            <Field label="Type">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Opening balance" hint="Negative for money owed">
              <input inputMode="decimal" value={form.opening} onChange={(e) => setForm({ ...form, opening: e.target.value })} />
            </Field>
          </div>
          <Field label="Institution">
            <input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.business} onChange={(e) => setForm({ ...form, business: e.target.checked })} />
            Business account
          </label>
        </Modal>
      )}
    </Card>
  );
}
