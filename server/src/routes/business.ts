import { Router } from 'express';
import { all, get, getSetting, run, scalar } from '../db.js';
import { crud } from '../lib/crud.js';
import { badRequest, notFound, toInt, wrap } from '../lib/http.js';
import { today } from '../services/recurrence.js';

export const businessRouter = Router();

/** Subtotal / tax / paid / balance for one invoice. */
export function invoiceTotals(invoiceId: number, taxRate = 0) {
  const subtotal = scalar<number>(
    'SELECT COALESCE(SUM(ROUND(quantity * unit_cents)), 0) FROM invoice_items WHERE invoice_id = ?',
    [invoiceId],
    0
  );
  const paid = scalar<number>(
    'SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments WHERE invoice_id = ?',
    [invoiceId],
    0
  );
  const tax = Math.round(subtotal * (taxRate / 100));
  const total = subtotal + tax;
  return {
    subtotal_cents: subtotal,
    tax_cents: tax,
    total_cents: total,
    paid_cents: paid,
    balance_cents: total - paid,
  };
}

businessRouter.use(
  '/clients',
  crud({
    table: 'clients',
    columns: [
      'name',
      'company',
      'email',
      'phone',
      'website',
      'status',
      'hourly_rate_cents',
      'notes',
      'archived',
    ],
    required: ['name'],
    filters: ['status', 'archived'],
    search: ['name', 'company', 'email'],
    orderBy: 'archived ASC, name ASC',
    describe: (r) => r?.name ?? '',
    hydrate: (row) => ({
      ...row,
      project_count: scalar<number>('SELECT COUNT(*) FROM projects WHERE client_id = ?', [row.id], 0),
      open_balance_cents: scalar<number>(
        `SELECT COALESCE(SUM(
                  (SELECT COALESCE(SUM(ROUND(i2.quantity * i2.unit_cents)), 0) FROM invoice_items i2 WHERE i2.invoice_id = i.id)
                  - (SELECT COALESCE(SUM(p.amount_cents), 0) FROM invoice_payments p WHERE p.invoice_id = i.id)
                ), 0)
           FROM invoices i WHERE i.client_id = ? AND i.status IN ('sent', 'draft')`,
        [row.id],
        0
      ),
      lifetime_cents: scalar<number>(
        `SELECT COALESCE(SUM(p.amount_cents), 0) FROM invoice_payments p
           JOIN invoices i ON i.id = p.invoice_id WHERE i.client_id = ?`,
        [row.id],
        0
      ),
    }),
  })
);

businessRouter.use(
  '/deals',
  crud({
    table: 'deals',
    columns: [
      'client_id',
      'title',
      'value_cents',
      'stage',
      'probability',
      'expected_close',
      'source',
      'notes',
      'closed_at',
    ],
    required: ['title'],
    filters: ['stage', 'client_id'],
    search: ['title', 'notes'],
    orderBy: 'expected_close ASC, value_cents DESC',
    describe: (r) => r?.title ?? '',
    hydrate: (row) => ({
      ...row,
      client_name: row.client_id
        ? scalar<string>('SELECT name FROM clients WHERE id = ?', [row.client_id], '')
        : '',
      weighted_cents: Math.round((row.value_cents * row.probability) / 100),
    }),
    beforeWrite: (data) => {
      if (data.stage === 'won' || data.stage === 'lost') {
        data.closed_at = data.closed_at ?? new Date().toISOString();
      }
    },
  })
);

/** Deal pipeline grouped by stage, with weighted value. */
businessRouter.get(
  '/pipeline',
  wrap((_req, res) => {
    const stages = ['lead', 'qualified', 'proposal', 'won', 'lost'];
    const deals = all<any>('SELECT * FROM deals ORDER BY value_cents DESC');
    res.json({
      stages: stages.map((stage) => {
        const inStage = deals.filter((d) => d.stage === stage);
        return {
          stage,
          count: inStage.length,
          value_cents: inStage.reduce((s, d) => s + d.value_cents, 0),
          weighted_cents: inStage.reduce((s, d) => s + Math.round((d.value_cents * d.probability) / 100), 0),
          deals: inStage.map((d) => ({
            ...d,
            client_name: d.client_id
              ? scalar<string>('SELECT name FROM clients WHERE id = ?', [d.client_id], '')
              : '',
          })),
        };
      }),
      open_value_cents: deals
        .filter((d) => !['won', 'lost'].includes(d.stage))
        .reduce((s, d) => s + d.value_cents, 0),
      weighted_open_cents: deals
        .filter((d) => !['won', 'lost'].includes(d.stage))
        .reduce((s, d) => s + Math.round((d.value_cents * d.probability) / 100), 0),
      won_this_year_cents: deals
        .filter((d) => d.stage === 'won' && (d.closed_at ?? '').slice(0, 4) === today().slice(0, 4))
        .reduce((s, d) => s + d.value_cents, 0),
    });
  })
);

/** Next invoice number in the configured series, e.g. INV-0007. */
function nextInvoiceNumber(): string {
  const prefix = getSetting<string>('invoicePrefix', 'INV-');
  const last = get<{ number: string }>(
    `SELECT number FROM invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  const seq = last ? Number(last.number.slice(prefix.length)) || 0 : 0;
  return `${prefix}${String(seq + 1).padStart(4, '0')}`;
}

businessRouter.use(
  '/invoices',
  crud({
    table: 'invoices',
    columns: [
      'client_id',
      'number',
      'status',
      'issue_date',
      'due_date',
      'currency',
      'tax_rate',
      'notes',
      'sent_at',
    ],
    filters: ['status', 'client_id'],
    search: ['number', 'notes'],
    orderBy: 'issue_date DESC, id DESC',
    describe: (r) => r?.number ?? '',
    beforeWrite: (data, _req, existing) => {
      if (!existing && !data.number) data.number = nextInvoiceNumber();
    },
    hydrate: (row) => ({
      ...row,
      client_name: row.client_id
        ? scalar<string>('SELECT name FROM clients WHERE id = ?', [row.client_id], '')
        : '',
      ...invoiceTotals(row.id, row.tax_rate),
      overdue:
        row.status === 'sent' && !!row.due_date && row.due_date < today(),
    }),
  })
);

businessRouter.get(
  '/invoices/:id/full',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const invoice = get<any>('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!invoice) throw notFound('Invoice');
    res.json({
      ...invoice,
      client: invoice.client_id ? get('SELECT * FROM clients WHERE id = ?', [invoice.client_id]) : null,
      items: all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id', [id]),
      payments: all('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_on', [id]),
      ...invoiceTotals(id, invoice.tax_rate),
    });
  })
);

businessRouter.use(
  '/invoice-items',
  crud({
    table: 'invoice_items',
    columns: ['invoice_id', 'description', 'quantity', 'unit_cents', 'position'],
    required: ['invoice_id'],
    filters: ['invoice_id'],
    orderBy: 'position ASC, id ASC',
  })
);

businessRouter.use(
  '/invoice-payments',
  crud({
    table: 'invoice_payments',
    columns: ['invoice_id', 'paid_on', 'amount_cents', 'method', 'reference'],
    required: ['invoice_id', 'amount_cents'],
    filters: ['invoice_id'],
    orderBy: 'paid_on DESC',
    afterWrite: (row, action) => {
      if (!row || action === 'delete') return;
      // Close the invoice automatically once it is fully settled.
      const invoice = get<any>('SELECT * FROM invoices WHERE id = ?', [row.invoice_id]);
      if (!invoice) return;
      const totals = invoiceTotals(invoice.id, invoice.tax_rate);
      if (totals.balance_cents <= 0 && invoice.status !== 'paid') {
        run(`UPDATE invoices SET status = 'paid' WHERE id = ?`, [invoice.id]);
      }
    },
  })
);

/**
 * Record a payment and, optionally, the matching deposit in a bank account so
 * the books and the budget stay in step.
 */
businessRouter.post(
  '/invoices/:id/payments',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const invoice = get<any>('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!invoice) throw notFound('Invoice');
    const amount = toInt(req.body?.amount_cents);
    if (!amount) throw badRequest('amount_cents is required');

    const info = run(
      `INSERT INTO invoice_payments (invoice_id, paid_on, amount_cents, method, reference)
       VALUES (?, ?, ?, ?, ?)`,
      [id, req.body?.paid_on ?? today(), amount, req.body?.method ?? '', req.body?.reference ?? '']
    );

    let transaction = null;
    const accountId = toInt(req.body?.account_id);
    if (accountId) {
      const txnInfo = run(
        `INSERT INTO transactions (account_id, category_id, txn_date, amount_cents, payee, memo, business, invoice_id, source)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'manual')`,
        [
          accountId,
          req.body?.category_id ?? null,
          req.body?.paid_on ?? today(),
          amount,
          scalar<string>('SELECT name FROM clients WHERE id = ?', [invoice.client_id], 'Client payment'),
          `Payment for ${invoice.number}`,
          id,
        ]
      );
      transaction = get('SELECT * FROM transactions WHERE id = ?', [Number(txnInfo.lastInsertRowid)]);
    }

    const totals = invoiceTotals(id, invoice.tax_rate);
    if (totals.balance_cents <= 0) run(`UPDATE invoices SET status = 'paid' WHERE id = ?`, [id]);

    res.status(201).json({
      payment: get('SELECT * FROM invoice_payments WHERE id = ?', [Number(info.lastInsertRowid)]),
      transaction,
      totals,
    });
  })
);

businessRouter.post(
  '/invoices/:id/send',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM invoices WHERE id = ?', [id])) throw notFound('Invoice');
    run(`UPDATE invoices SET status = 'sent', sent_at = datetime('now') WHERE id = ?`, [id]);
    res.json(get('SELECT * FROM invoices WHERE id = ?', [id]));
  })
);

/** Turn unbilled tracked time into invoice line items. */
businessRouter.post(
  '/invoices/:id/bill-time',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const invoice = get<any>('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!invoice) throw notFound('Invoice');
    const projectId = toInt(req.body?.project_id);
    if (!projectId) throw badRequest('project_id is required');

    const entries = all<any>(
      `SELECT * FROM time_entries
        WHERE project_id = ? AND billable = 1 AND invoiced = 0 AND ended_at IS NOT NULL`,
      [projectId]
    );
    if (!entries.length) return res.json({ added: 0, minutes: 0 });

    const project = get<any>('SELECT * FROM projects WHERE id = ?', [projectId]);
    const minutes = entries.reduce((s, e) => s + e.minutes, 0);
    const rate = toInt(req.body?.rate_cents) || project?.rate_cents || 0;
    const position = scalar<number>(
      'SELECT COALESCE(MAX(position), 0) + 1 FROM invoice_items WHERE invoice_id = ?',
      [id],
      1
    );

    run(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_cents, position)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        `${project?.name ?? 'Project'} - tracked time`,
        Math.round((minutes / 60) * 100) / 100,
        rate,
        position,
      ]
    );
    for (const entry of entries) {
      run('UPDATE time_entries SET invoiced = 1 WHERE id = ?', [entry.id]);
    }

    res.json({ added: 1, entries: entries.length, minutes, totals: invoiceTotals(id, invoice.tax_rate) });
  })
);

businessRouter.use(
  '/metrics',
  crud({
    table: 'metrics',
    columns: ['key', 'label', 'unit', 'target', 'direction'],
    required: ['key', 'label'],
    orderBy: 'label ASC',
    describe: (r) => r?.label ?? '',
    hydrate: (row) => ({
      ...row,
      values: all(
        'SELECT period, value FROM metric_values WHERE metric_id = ? ORDER BY period DESC LIMIT 24',
        [row.id]
      ),
    }),
  })
);

businessRouter.use(
  '/metric-values',
  crud({
    table: 'metric_values',
    columns: ['metric_id', 'period', 'value'],
    required: ['metric_id', 'period'],
    filters: ['metric_id', 'period'],
    orderBy: 'period DESC',
    beforeWrite: (data) => {
      if (typeof data.period === 'string') data.period = data.period.slice(0, 10);
    },
  })
);

/** Upsert a KPI reading without the client tracking row ids. */
businessRouter.put(
  '/metrics/:id/values/:period',
  wrap((req, res) => {
    const metricId = toInt(req.params.id);
    const period = String(req.params.period).slice(0, 10);
    run(
      `INSERT INTO metric_values (metric_id, period, value) VALUES (?, ?, ?)
       ON CONFLICT(metric_id, period) DO UPDATE SET value = excluded.value`,
      [metricId, period, Number(req.body?.value ?? 0)]
    );
    res.json(get('SELECT * FROM metric_values WHERE metric_id = ? AND period = ?', [metricId, period]));
  })
);

businessRouter.use(
  '/notes',
  crud({
    table: 'notes',
    columns: ['title', 'body', 'entity_type', 'entity_id', 'pinned'],
    filters: ['entity_type', 'entity_id', 'pinned'],
    search: ['title', 'body'],
    orderBy: 'pinned DESC, updated_at DESC',
    describe: (r) => r?.title ?? '',
    beforeWrite: (data) => {
      data.updated_at = new Date().toISOString();
    },
  })
);

/** Business home screen: revenue, receivables, pipeline and KPIs. */
businessRouter.get(
  '/business-overview',
  wrap((_req, res) => {
    const invoices = all<any>('SELECT * FROM invoices');
    const withTotals = invoices.map((inv) => ({ ...inv, ...invoiceTotals(inv.id, inv.tax_rate) }));
    const outstanding = withTotals.filter((i) => i.status === 'sent');

    res.json({
      revenue: {
        collected_ytd_cents: scalar<number>(
          `SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments
            WHERE strftime('%Y', paid_on) = strftime('%Y', 'now')`,
          [],
          0
        ),
        collected_mtd_cents: scalar<number>(
          `SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments
            WHERE strftime('%Y-%m', paid_on) = strftime('%Y-%m', 'now')`,
          [],
          0
        ),
        by_month: all(
          `SELECT substr(paid_on, 1, 7) AS month, SUM(amount_cents) AS cents
             FROM invoice_payments
            WHERE paid_on >= date('now', '-12 months')
            GROUP BY month ORDER BY month`
        ),
      },
      receivables: {
        outstanding_cents: outstanding.reduce((s, i) => s + i.balance_cents, 0),
        overdue_cents: outstanding
          .filter((i) => i.due_date && i.due_date < today())
          .reduce((s, i) => s + i.balance_cents, 0),
        count: outstanding.length,
        invoices: outstanding
          .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
          .slice(0, 10)
          .map((i) => ({
            ...i,
            client_name: i.client_id
              ? scalar<string>('SELECT name FROM clients WHERE id = ?', [i.client_id], '')
              : '',
          })),
      },
      clients: {
        total: scalar<number>('SELECT COUNT(*) FROM clients WHERE archived = 0', [], 0),
        active: scalar<number>(`SELECT COUNT(*) FROM clients WHERE status = 'active' AND archived = 0`, [], 0),
        top: all(
          `SELECT c.id, c.name,
                  COALESCE(SUM(p.amount_cents), 0) AS revenue_cents
             FROM clients c
             LEFT JOIN invoices i ON i.client_id = c.id
             LEFT JOIN invoice_payments p ON p.invoice_id = i.id
            GROUP BY c.id ORDER BY revenue_cents DESC LIMIT 5`
        ),
      },
      metrics: all<any>('SELECT * FROM metrics ORDER BY label').map((m) => ({
        ...m,
        latest: get('SELECT period, value FROM metric_values WHERE metric_id = ? ORDER BY period DESC LIMIT 1', [m.id]),
        history: all(
          'SELECT period, value FROM metric_values WHERE metric_id = ? ORDER BY period DESC LIMIT 12',
          [m.id]
        ),
      })),
      notes: all('SELECT * FROM notes WHERE pinned = 1 ORDER BY updated_at DESC LIMIT 5'),
    });
  })
);
