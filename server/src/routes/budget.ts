import { Router } from 'express';
import { all, db, get, run, scalar } from '../db.js';
import { crud } from '../lib/crud.js';
import { badRequest, notFound, toInt, wrap } from '../lib/http.js';
import { parseCsvObjects, toCents, toIsoDate } from '../lib/csv.js';
import { addMonthsToKey, advance, monthRange, today, type Cadence } from '../services/recurrence.js';

export const budgetRouter = Router();

const balanceSql = `
  a.opening_cents + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id), 0)
`;

budgetRouter.use(
  '/accounts',
  crud({
    table: 'accounts',
    columns: ['name', 'type', 'institution', 'currency', 'opening_cents', 'business', 'archived'],
    required: ['name'],
    filters: ['type', 'business', 'archived'],
    search: ['name', 'institution'],
    orderBy: 'archived ASC, name ASC',
    describe: (r) => r?.name ?? '',
    hydrate: (row) => ({
      ...row,
      balance_cents:
        row.opening_cents +
        scalar<number>('SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE account_id = ?', [row.id], 0),
      transaction_count: scalar<number>('SELECT COUNT(*) FROM transactions WHERE account_id = ?', [row.id], 0),
    }),
  })
);

budgetRouter.use(
  '/categories',
  crud({
    table: 'categories',
    columns: ['name', 'parent_id', 'kind', 'color', 'business', 'archived'],
    required: ['name'],
    filters: ['kind', 'business', 'archived', 'parent_id'],
    search: ['name'],
    orderBy: 'kind ASC, name ASC',
    describe: (r) => r?.name ?? '',
  })
);

budgetRouter.use(
  '/transactions',
  crud({
    table: 'transactions',
    columns: [
      'account_id',
      'category_id',
      'txn_date',
      'amount_cents',
      'payee',
      'memo',
      'cleared',
      'business',
      'transfer_id',
      'invoice_id',
      'source',
      'external_id',
    ],
    required: ['account_id'],
    filters: ['account_id', 'category_id', 'cleared', 'business', 'source'],
    search: ['payee', 'memo'],
    orderBy: 'txn_date DESC, id DESC',
    sortable: ['txn_date', 'amount_cents', 'payee', 'id'],
    describe: (r) => `${r?.payee ?? ''} ${((r?.amount_cents ?? 0) / 100).toFixed(2)}`,
    // Date-window filtering is expressed as ?from=&to= rather than exact match.
    scope: (req) => {
      const clauses: string[] = [];
      const params: any[] = [];
      if (req.query.from) {
        clauses.push('txn_date >= ?');
        params.push(String(req.query.from).slice(0, 10));
      }
      if (req.query.to) {
        clauses.push('txn_date <= ?');
        params.push(String(req.query.to).slice(0, 10));
      }
      if (req.query.uncategorized === '1') clauses.push('category_id IS NULL');
      return clauses.length ? { sql: clauses.join(' AND '), params } : null;
    },
    hydrate: (row) => ({
      ...row,
      account_name: scalar<string>('SELECT name FROM accounts WHERE id = ?', [row.account_id], ''),
      category_name: row.category_id
        ? scalar<string>('SELECT name FROM categories WHERE id = ?', [row.category_id], '')
        : '',
    }),
  })
);

/** Move money between two accounts as a linked pair of transactions. */
budgetRouter.post(
  '/transactions/transfer',
  wrap((req, res) => {
    const fromId = toInt(req.body?.from_account_id);
    const toId = toInt(req.body?.to_account_id);
    const amount = Math.abs(toInt(req.body?.amount_cents));
    if (!fromId || !toId) throw badRequest('from_account_id and to_account_id are required');
    if (fromId === toId) throw badRequest('Cannot transfer to the same account');
    if (!amount) throw badRequest('amount_cents must be non-zero');

    const date = String(req.body?.txn_date ?? today()).slice(0, 10);
    const memo = req.body?.memo ?? 'Transfer';

    const pair = db.transaction(() => {
      const outInfo = run(
        `INSERT INTO transactions (account_id, txn_date, amount_cents, payee, memo, source)
         VALUES (?, ?, ?, ?, ?, 'manual')`,
        [fromId, date, -amount, 'Transfer out', memo]
      );
      const inInfo = run(
        `INSERT INTO transactions (account_id, txn_date, amount_cents, payee, memo, source, transfer_id)
         VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
        [toId, date, amount, 'Transfer in', memo, Number(outInfo.lastInsertRowid)]
      );
      run('UPDATE transactions SET transfer_id = ? WHERE id = ?', [
        Number(inInfo.lastInsertRowid),
        Number(outInfo.lastInsertRowid),
      ]);
      return [Number(outInfo.lastInsertRowid), Number(inInfo.lastInsertRowid)];
    })();

    res.status(201).json({
      items: pair.map((id) => get('SELECT * FROM transactions WHERE id = ?', [id])),
    });
  })
);

/**
 * Import a bank/card CSV. Column names are auto-detected; rows already present
 * (same account, date, amount and payee) are skipped so re-importing an
 * overlapping export does not double-count.
 */
budgetRouter.post(
  '/transactions/import',
  wrap((req, res) => {
    const accountId = toInt(req.body?.account_id);
    const csv = String(req.body?.csv ?? '');
    if (!accountId) throw badRequest('account_id is required');
    if (!csv.trim()) throw badRequest('csv content is required');
    if (!get('SELECT id FROM accounts WHERE id = ?', [accountId])) throw notFound('Account');

    const rows = parseCsvObjects(csv);
    if (!rows.length) throw badRequest('No data rows found in the CSV');

    const headers = Object.keys(rows[0]);
    const pickHeader = (...candidates: string[]) =>
      headers.find((h) => candidates.some((c) => h === c)) ??
      headers.find((h) => candidates.some((c) => h.includes(c)));

    const dateKey = req.body?.map?.date ?? pickHeader('date', 'posted', 'transaction_date');
    const payeeKey =
      req.body?.map?.payee ?? pickHeader('payee', 'description', 'name', 'merchant', 'details');
    const memoKey = req.body?.map?.memo ?? pickHeader('memo', 'notes', 'note');
    const amountKey = req.body?.map?.amount ?? pickHeader('amount', 'value');
    const debitKey = req.body?.map?.debit ?? pickHeader('debit', 'withdrawal');
    const creditKey = req.body?.map?.credit ?? pickHeader('credit', 'deposit');

    if (!dateKey) throw badRequest(`Could not find a date column. Columns seen: ${headers.join(', ')}`);
    if (!amountKey && !debitKey && !creditKey) {
      throw badRequest(`Could not find an amount column. Columns seen: ${headers.join(', ')}`);
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    const importAll = db.transaction(() => {
      for (const [index, row] of rows.entries()) {
        const date = toIsoDate(row[dateKey]);
        let cents: number | null = null;

        if (amountKey && row[amountKey]) {
          cents = toCents(row[amountKey]);
        } else {
          const debit = debitKey ? toCents(row[debitKey]) : null;
          const credit = creditKey ? toCents(row[creditKey]) : null;
          if (debit) cents = -Math.abs(debit);
          else if (credit) cents = Math.abs(credit);
        }

        if (!date || cents === null) {
          errors.push(`Row ${index + 2}: could not read date or amount`);
          continue;
        }

        const payee = payeeKey ? row[payeeKey] ?? '' : '';
        const duplicate = get(
          `SELECT id FROM transactions
            WHERE account_id = ? AND txn_date = ? AND amount_cents = ? AND payee = ?`,
          [accountId, date, cents, payee]
        );
        if (duplicate) {
          skipped += 1;
          continue;
        }

        run(
          `INSERT INTO transactions (account_id, txn_date, amount_cents, payee, memo, source)
           VALUES (?, ?, ?, ?, ?, 'import')`,
          [accountId, date, cents, payee, memoKey ? row[memoKey] ?? '' : '']
        );
        imported += 1;
      }
    });
    importAll();

    res.json({
      imported,
      skipped,
      errors: errors.slice(0, 20),
      detected: { date: dateKey, payee: payeeKey, amount: amountKey, debit: debitKey, credit: creditKey },
    });
  })
);

budgetRouter.use(
  '/budgets',
  crud({
    table: 'budgets',
    columns: ['month', 'category_id', 'amount_cents', 'rollover'],
    required: ['month', 'category_id'],
    filters: ['month', 'category_id'],
    orderBy: 'month DESC',
  })
);

/** Set (or clear) an envelope in one call, without the client tracking ids. */
budgetRouter.put(
  '/budgets/:month/:categoryId',
  wrap((req, res) => {
    const month = String(req.params.month).slice(0, 7);
    const categoryId = toInt(req.params.categoryId);
    const amount = toInt(req.body?.amount_cents);
    run(
      `INSERT INTO budgets (month, category_id, amount_cents, rollover) VALUES (?, ?, ?, ?)
       ON CONFLICT(month, category_id) DO UPDATE SET
         amount_cents = excluded.amount_cents, rollover = excluded.rollover`,
      [month, categoryId, amount, req.body?.rollover ? 1 : 0]
    );
    res.json(get('SELECT * FROM budgets WHERE month = ? AND category_id = ?', [month, categoryId]));
  })
);

/** Envelope report for a month: budgeted vs actual vs remaining, per category. */
budgetRouter.get(
  '/budget-month/:month',
  wrap((req, res) => {
    const month = String(req.params.month).slice(0, 7);
    const { start, end } = monthRange(month);

    const categories = all<any>(
      `SELECT c.*,
              COALESCE(b.amount_cents, 0) AS budgeted_cents,
              COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                         WHERE t.category_id = c.id AND t.txn_date BETWEEN ? AND ?), 0) AS actual_cents
         FROM categories c
         LEFT JOIN budgets b ON b.category_id = c.id AND b.month = ?
        WHERE c.archived = 0
        ORDER BY c.kind, c.name`,
      [start, end, month]
    ).map((row) => {
      // Expenses are stored negative; report them as positive spend.
      const spent = row.kind === 'expense' ? -row.actual_cents : row.actual_cents;
      return {
        ...row,
        actual_cents: spent,
        remaining_cents: row.budgeted_cents - spent,
        percent_used: row.budgeted_cents > 0 ? Math.round((spent / row.budgeted_cents) * 100) : null,
      };
    });

    const income = scalar<number>(
      `SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
        WHERE txn_date BETWEEN ? AND ? AND amount_cents > 0 AND transfer_id IS NULL`,
      [start, end],
      0
    );
    const expense = scalar<number>(
      `SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
        WHERE txn_date BETWEEN ? AND ? AND amount_cents < 0 AND transfer_id IS NULL`,
      [start, end],
      0
    );

    res.json({
      month,
      categories,
      totals: {
        budgeted_cents: categories
          .filter((c) => c.kind === 'expense')
          .reduce((s, c) => s + c.budgeted_cents, 0),
        spent_cents: categories.filter((c) => c.kind === 'expense').reduce((s, c) => s + c.actual_cents, 0),
        income_cents: income,
        expense_cents: -expense,
        net_cents: income + expense,
      },
      unbudgeted: all(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
           FROM transactions WHERE category_id IS NULL AND txn_date BETWEEN ? AND ?`,
        [start, end]
      )[0],
    });
  })
);

/** Copy an entire month of envelopes forward. */
budgetRouter.post(
  '/budget-month/:month/copy',
  wrap((req, res) => {
    const from = String(req.params.month).slice(0, 7);
    const to = String(req.body?.to ?? addMonthsToKey(from, 1)).slice(0, 7);
    const rows = all<any>('SELECT * FROM budgets WHERE month = ?', [from]);
    for (const row of rows) {
      run(
        `INSERT INTO budgets (month, category_id, amount_cents, rollover) VALUES (?, ?, ?, ?)
         ON CONFLICT(month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents`,
        [to, row.category_id, row.amount_cents, row.rollover]
      );
    }
    res.json({ copied: rows.length, to });
  })
);

budgetRouter.use(
  '/recurring-transactions',
  crud({
    table: 'recurring_transactions',
    columns: [
      'account_id',
      'category_id',
      'payee',
      'memo',
      'amount_cents',
      'cadence',
      'next_date',
      'end_date',
      'auto_post',
      'business',
      'active',
    ],
    required: ['account_id', 'next_date'],
    filters: ['account_id', 'active', 'cadence'],
    search: ['payee', 'memo'],
    orderBy: 'next_date ASC',
    describe: (r) => r?.payee ?? '',
  })
);

/** Post a scheduled transaction immediately and roll its date forward. */
budgetRouter.post(
  '/recurring-transactions/:id/post',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const rec = get<any>('SELECT * FROM recurring_transactions WHERE id = ?', [id]);
    if (!rec) throw notFound('Recurring transaction');
    const info = run(
      `INSERT INTO transactions (account_id, category_id, txn_date, amount_cents, payee, memo, business, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'recurring')`,
      [rec.account_id, rec.category_id, rec.next_date, rec.amount_cents, rec.payee, rec.memo, rec.business]
    );
    const next = advance(rec.next_date, rec.cadence as Cadence);
    const done = rec.end_date && next > rec.end_date;
    run('UPDATE recurring_transactions SET next_date = ?, active = ? WHERE id = ?', [
      next,
      done ? 0 : rec.active,
      id,
    ]);
    res.status(201).json({
      transaction: get('SELECT * FROM transactions WHERE id = ?', [Number(info.lastInsertRowid)]),
      recurring: get('SELECT * FROM recurring_transactions WHERE id = ?', [id]),
    });
  })
);

budgetRouter.use(
  '/savings-goals',
  crud({
    table: 'savings_goals',
    columns: ['name', 'target_cents', 'saved_cents', 'target_date', 'account_id'],
    required: ['name'],
    orderBy: 'target_date ASC, name ASC',
    describe: (r) => r?.name ?? '',
    hydrate: (row) => ({
      ...row,
      percent: row.target_cents > 0 ? Math.round((row.saved_cents / row.target_cents) * 100) : 0,
    }),
  })
);

/** Money home screen: net worth, cashflow trend, category spend, upcoming bills. */
budgetRouter.get(
  '/budget-overview',
  wrap((req, res) => {
    const months = Math.min(Math.max(toInt(req.query.months, 6), 1), 24);
    const accounts = all<any>(
      `SELECT a.*, ${balanceSql} AS balance_cents FROM accounts a WHERE a.archived = 0 ORDER BY a.name`
    );

    const assetTypes = new Set(['checking', 'savings', 'cash', 'investment']);
    const assets = accounts
      .filter((a) => assetTypes.has(a.type))
      .reduce((s, a) => s + a.balance_cents, 0);
    const liabilities = accounts
      .filter((a) => !assetTypes.has(a.type))
      .reduce((s, a) => s + a.balance_cents, 0);

    const cashflow = all(
      `SELECT substr(txn_date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END), 0) AS expense_cents
         FROM transactions
        WHERE transfer_id IS NULL AND txn_date >= date('now', ?)
        GROUP BY month ORDER BY month`,
      [`-${months} months`]
    );

    const byCategory = all(
      `SELECT COALESCE(c.name, 'Uncategorised') AS category,
              COALESCE(c.color, '#94a3b8') AS color,
              SUM(-t.amount_cents) AS spent_cents
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.amount_cents < 0 AND t.transfer_id IS NULL
          AND t.txn_date >= date('now', 'start of month')
        GROUP BY category ORDER BY spent_cents DESC LIMIT 12`
    );

    res.json({
      accounts,
      net_worth_cents: assets + liabilities,
      assets_cents: assets,
      liabilities_cents: liabilities,
      cashflow,
      by_category: byCategory,
      upcoming: all(
        `SELECT r.*, a.name AS account_name FROM recurring_transactions r
           JOIN accounts a ON a.id = r.account_id
          WHERE r.active = 1 AND r.next_date <= date('now', '+30 days')
          ORDER BY r.next_date LIMIT 20`
      ),
      goals: all('SELECT * FROM savings_goals ORDER BY target_date').map((g: any) => ({
        ...g,
        percent: g.target_cents > 0 ? Math.round((g.saved_cents / g.target_cents) * 100) : 0,
      })),
      uncategorized: scalar<number>(
        'SELECT COUNT(*) FROM transactions WHERE category_id IS NULL',
        [],
        0
      ),
    });
  })
);
