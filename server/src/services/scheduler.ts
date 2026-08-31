import { config } from '../config.js';
import { all, get, getSetting, logActivity, run } from '../db.js';
import { purgeExpiredSessions } from '../lib/auth.js';
import { duePostIds, publishPost } from './social/publisher.js';
import { checkRank, recordRanking, keywordsToRefresh, serpProviderId } from './seo/serp.js';
import { advance, type Cadence } from './recurrence.js';

let running = false;
let timer: NodeJS.Timeout | null = null;

/** Publish every scheduled post whose time has come. */
async function processSocialQueue() {
  for (const postId of duePostIds()) {
    try {
      await publishPost(postId);
    } catch (err) {
      console.error(`[helm] failed publishing post ${postId}:`, err);
    }
  }
}

/** Post due recurring transactions and roll their next date forward. */
function processRecurringTransactions() {
  const due = all<any>(
    `SELECT * FROM recurring_transactions
      WHERE active = 1 AND auto_post = 1 AND next_date <= date('now')`
  );
  for (const rec of due) {
    // Catch up one occurrence per tick so a long gap does not post a burst.
    run(
      `INSERT INTO transactions (account_id, category_id, txn_date, amount_cents, payee, memo, business, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'recurring')`,
      [rec.account_id, rec.category_id, rec.next_date, rec.amount_cents, rec.payee, rec.memo, rec.business]
    );
    const next = advance(rec.next_date, rec.cadence as Cadence);
    const finished = rec.end_date && next > rec.end_date;
    run('UPDATE recurring_transactions SET next_date = ?, active = ? WHERE id = ?', [
      next,
      finished ? 0 : 1,
      rec.id,
    ]);
    logActivity('recurring_transactions', rec.id, 'post', `${rec.payee} auto-posted`);
  }
}

/**
 * Refresh a few keyword rankings per day. Deliberately rate-limited: SERP API
 * calls are the one thing here that costs money per request.
 */
async function processRankChecks() {
  if (serpProviderId() === 'manual') return;
  if (!getSetting<boolean>('seoAutoRankCheck', false)) return;

  const dailyLimit = getSetting<number>('seoDailyRankLimit', 10);
  const checkedToday = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM seo_rankings WHERE checked_on = date('now')`
  );
  const remaining = dailyLimit - (checkedToday?.n ?? 0);
  if (remaining <= 0) return;

  for (const keyword of keywordsToRefresh(Math.min(remaining, 5))) {
    try {
      const result = await checkRank(
        keyword.keyword,
        keyword.target_url || keyword.base_url,
        keyword.country,
        keyword.device
      );
      recordRanking(keyword.id, result);
    } catch (err) {
      console.error(`[helm] rank check failed for "${keyword.keyword}":`, err);
      // One failure (usually quota) means the rest will fail too.
      break;
    }
  }
}

export async function tick() {
  if (running) return;
  running = true;
  try {
    await processSocialQueue();
    processRecurringTransactions();
    await processRankChecks();
    purgeExpiredSessions();
  } catch (err) {
    console.error('[helm] scheduler tick failed:', err);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => void tick(), config.tickMs);
  // Don't hold the process open purely for the scheduler.
  timer.unref?.();
  void tick();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
