import { Router } from 'express';
import { all, get, scalar } from '../db.js';
import { wrap } from '../lib/http.js';
import { monthRange, today } from '../services/recurrence.js';

export const dashboardRouter = Router();

type Alert = {
  severity: 'critical' | 'warning' | 'info';
  module: string;
  message: string;
  link: string;
};

/**
 * Cross-module attention list. This is the reason the modules share one
 * database: an overdue invoice, a failed post and an over-budget envelope all
 * surface in the same place.
 */
function buildAlerts(): Alert[] {
  const alerts: Alert[] = [];
  const push = (a: Alert) => alerts.push(a);

  const overdueInvoices = scalar<number>(
    `SELECT COUNT(*) FROM invoices WHERE status = 'sent' AND due_date IS NOT NULL AND due_date < date('now')`,
    [],
    0
  );
  if (overdueInvoices) {
    push({
      severity: 'critical',
      module: 'business',
      message: `${overdueInvoices} invoice${overdueInvoices > 1 ? 's are' : ' is'} overdue`,
      link: '/business',
    });
  }

  const overdueTasks = scalar<number>(
    `SELECT COUNT(*) FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < date('now')`,
    [],
    0
  );
  if (overdueTasks) {
    push({
      severity: 'warning',
      module: 'tasks',
      message: `${overdueTasks} task${overdueTasks > 1 ? 's are' : ' is'} past due`,
      link: '/tasks',
    });
  }

  const failedPosts = scalar<number>(
    `SELECT COUNT(*) FROM social_post_targets WHERE status = 'failed'`,
    [],
    0
  );
  if (failedPosts) {
    push({
      severity: 'critical',
      module: 'social',
      message: `${failedPosts} social post${failedPosts > 1 ? 's' : ''} failed to publish`,
      link: '/social',
    });
  }

  const manualPosts = scalar<number>(
    `SELECT COUNT(*) FROM social_post_targets WHERE status = 'manual_required'`,
    [],
    0
  );
  if (manualPosts) {
    push({
      severity: 'info',
      module: 'social',
      message: `${manualPosts} post${manualPosts > 1 ? 's are' : ' is'} waiting to be posted by hand`,
      link: '/social',
    });
  }

  const { start, end } = monthRange(today().slice(0, 7));
  const overBudget = all<{ name: string }>(
    `SELECT c.name FROM categories c
       JOIN budgets b ON b.category_id = c.id AND b.month = ?
      WHERE b.amount_cents > 0
        AND -COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                        WHERE t.category_id = c.id AND t.txn_date BETWEEN ? AND ?), 0) > b.amount_cents`,
    [today().slice(0, 7), start, end]
  );
  for (const row of overBudget.slice(0, 4)) {
    push({
      severity: 'warning',
      module: 'budget',
      message: `Over budget in ${row.name} this month`,
      link: '/budget',
    });
  }

  const uncategorized = scalar<number>(
    'SELECT COUNT(*) FROM transactions WHERE category_id IS NULL',
    [],
    0
  );
  if (uncategorized >= 5) {
    push({
      severity: 'info',
      module: 'budget',
      message: `${uncategorized} transactions need a category`,
      link: '/budget',
    });
  }

  const staleCrawl = get<{ name: string }>(
    `SELECT s.name FROM seo_sites s
      WHERE NOT EXISTS (
        SELECT 1 FROM seo_crawls c
         WHERE c.site_id = s.id AND c.status = 'done' AND c.started_at > datetime('now', '-30 days')
      ) LIMIT 1`
  );
  if (staleCrawl) {
    push({
      severity: 'info',
      module: 'seo',
      message: `${staleCrawl.name} has not been crawled in over 30 days`,
      link: '/seo',
    });
  }

  const overdueLearning = scalar<number>(
    `SELECT COUNT(*) FROM learning_plan_items i
       JOIN learning_plans p ON p.id = i.plan_id
      WHERE p.status = 'active' AND i.status NOT IN ('done', 'skipped')
        AND i.due_date IS NOT NULL AND i.due_date < date('now')`,
    [],
    0
  );
  if (overdueLearning) {
    push({
      severity: 'info',
      module: 'skills',
      message: `${overdueLearning} learning plan step${overdueLearning > 1 ? 's are' : ' is'} past due`,
      link: '/skills',
    });
  }

  return alerts;
}

dashboardRouter.get(
  '/',
  wrap((_req, res) => {
    const month = today().slice(0, 7);
    const { start, end } = monthRange(month);

    const assetTypes = `('checking','savings','cash','investment')`;
    const netWorth =
      scalar<number>(
        `SELECT COALESCE(SUM(opening_cents), 0) FROM accounts WHERE archived = 0`,
        [],
        0
      ) +
      scalar<number>(
        `SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
           JOIN accounts a ON a.id = t.account_id WHERE a.archived = 0`,
        [],
        0
      );

    res.json({
      generated_at: new Date().toISOString(),
      alerts: buildAlerts(),

      money: {
        net_worth_cents: netWorth,
        liquid_cents:
          scalar<number>(
            `SELECT COALESCE(SUM(opening_cents), 0) FROM accounts WHERE archived = 0 AND type IN ${assetTypes}`,
            [],
            0
          ) +
          scalar<number>(
            `SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
               JOIN accounts a ON a.id = t.account_id
              WHERE a.archived = 0 AND a.type IN ${assetTypes}`,
            [],
            0
          ),
        income_mtd_cents: scalar<number>(
          `SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
            WHERE amount_cents > 0 AND transfer_id IS NULL AND txn_date BETWEEN ? AND ?`,
          [start, end],
          0
        ),
        expense_mtd_cents: scalar<number>(
          `SELECT COALESCE(-SUM(amount_cents), 0) FROM transactions
            WHERE amount_cents < 0 AND transfer_id IS NULL AND txn_date BETWEEN ? AND ?`,
          [start, end],
          0
        ),
        cashflow: all(
          `SELECT substr(txn_date, 1, 7) AS month,
                  COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS income_cents,
                  COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END), 0) AS expense_cents
             FROM transactions
            WHERE transfer_id IS NULL AND txn_date >= date('now', '-6 months')
            GROUP BY month ORDER BY month`
        ),
      },

      work: {
        open_tasks: scalar<number>(`SELECT COUNT(*) FROM tasks WHERE status != 'done'`, [], 0),
        due_today: scalar<number>(
          `SELECT COUNT(*) FROM tasks WHERE status != 'done' AND due_date = date('now')`,
          [],
          0
        ),
        overdue: scalar<number>(
          `SELECT COUNT(*) FROM tasks WHERE status != 'done' AND due_date < date('now')`,
          [],
          0
        ),
        completed_this_week: scalar<number>(
          `SELECT COUNT(*) FROM tasks WHERE status = 'done' AND completed_at >= datetime('now', '-7 days')`,
          [],
          0
        ),
        hours_this_week:
          Math.round(
            (scalar<number>(
              `SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE started_at >= datetime('now', '-7 days')`,
              [],
              0
            ) /
              60) *
              10
          ) / 10,
        active_projects: scalar<number>(
          `SELECT COUNT(*) FROM projects WHERE archived = 0 AND status = 'active'`,
          [],
          0
        ),
        next: all(
          `SELECT t.id, t.title, t.due_date, t.priority, t.status, p.name AS project_name, p.color AS project_color
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.status != 'done' AND t.due_date IS NOT NULL
            ORDER BY t.due_date ASC LIMIT 8`
        ),
        running_timer: get('SELECT * FROM time_entries WHERE ended_at IS NULL LIMIT 1') ?? null,
      },

      revenue: {
        collected_mtd_cents: scalar<number>(
          `SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments WHERE paid_on BETWEEN ? AND ?`,
          [start, end],
          0
        ),
        collected_ytd_cents: scalar<number>(
          `SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments
            WHERE strftime('%Y', paid_on) = strftime('%Y', 'now')`,
          [],
          0
        ),
        outstanding_cents: scalar<number>(
          `SELECT COALESCE(SUM(
              (SELECT COALESCE(SUM(ROUND(it.quantity * it.unit_cents)), 0) FROM invoice_items it WHERE it.invoice_id = i.id)
              * (1 + i.tax_rate / 100.0)
              - (SELECT COALESCE(SUM(p.amount_cents), 0) FROM invoice_payments p WHERE p.invoice_id = i.id)
            ), 0)
            FROM invoices i WHERE i.status = 'sent'`,
          [],
          0
        ),
        pipeline_weighted_cents: scalar<number>(
          `SELECT COALESCE(SUM(value_cents * probability / 100), 0) FROM deals
            WHERE stage NOT IN ('won', 'lost')`,
          [],
          0
        ),
        by_month: all(
          `SELECT substr(paid_on, 1, 7) AS month, SUM(amount_cents) AS cents
             FROM invoice_payments WHERE paid_on >= date('now', '-6 months')
            GROUP BY month ORDER BY month`
        ),
      },

      social: {
        scheduled: scalar<number>(`SELECT COUNT(*) FROM social_posts WHERE status = 'scheduled'`, [], 0),
        next_7_days: scalar<number>(
          `SELECT COUNT(*) FROM social_posts
            WHERE status = 'scheduled' AND scheduled_at BETWEEN datetime('now') AND datetime('now', '+7 days')`,
          [],
          0
        ),
        published_30d: scalar<number>(
          `SELECT COUNT(*) FROM social_post_targets
            WHERE status = 'published' AND published_at >= datetime('now', '-30 days')`,
          [],
          0
        ),
        needs_attention: scalar<number>(
          `SELECT COUNT(*) FROM social_post_targets WHERE status IN ('failed', 'manual_required')`,
          [],
          0
        ),
        upcoming: all(
          `SELECT id, body, scheduled_at, status FROM social_posts
            WHERE status = 'scheduled' AND scheduled_at IS NOT NULL
            ORDER BY scheduled_at LIMIT 5`
        ),
      },

      seo: {
        sites: scalar<number>('SELECT COUNT(*) FROM seo_sites', [], 0),
        tracked_keywords: scalar<number>('SELECT COUNT(*) FROM seo_keywords WHERE tracked = 1', [], 0),
        avg_health: scalar<number>(
          `SELECT COALESCE(ROUND(AVG(health_score)), 0) FROM seo_crawls
            WHERE status = 'done' AND id IN (
              SELECT MAX(id) FROM seo_crawls WHERE status = 'done' GROUP BY site_id
            )`,
          [],
          0
        ),
        top3: scalar<number>(
          `SELECT COUNT(*) FROM seo_keywords k
            WHERE (SELECT position FROM seo_rankings r WHERE r.keyword_id = k.id
                    ORDER BY checked_on DESC LIMIT 1) <= 3`,
          [],
          0
        ),
        ai_citations: scalar<number>(
          `SELECT COUNT(*) FROM seo_keywords k
            WHERE (SELECT ai_overview FROM seo_rankings r WHERE r.keyword_id = k.id
                    ORDER BY checked_on DESC LIMIT 1) = 1`,
          [],
          0
        ),
      },

      skills: {
        tracked: scalar<number>('SELECT COUNT(*) FROM skills WHERE archived = 0', [], 0),
        assessed: scalar<number>('SELECT COUNT(DISTINCT skill_id) FROM skill_assessments', [], 0),
        active_plan: get(
          `SELECT id, name, weekly_minutes FROM learning_plans
            WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
        ) ?? null,
        steps_open: scalar<number>(
          `SELECT COUNT(*) FROM learning_plan_items i
             JOIN learning_plans p ON p.id = i.plan_id
            WHERE p.status = 'active' AND i.status NOT IN ('done', 'skipped')`,
          [],
          0
        ),
        course_clicks_30d: scalar<number>(
          `SELECT COUNT(*) FROM affiliate_clicks WHERE clicked_at >= datetime('now', '-30 days')`,
          [],
          0
        ),
      },

      activity: all(
        `SELECT entity_type, entity_id, action, summary, created_at
           FROM activity ORDER BY created_at DESC LIMIT 15`
      ),
    });
  })
);
