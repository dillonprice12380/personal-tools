/**
 * Learning plan generation.
 *
 * A gap report says what is missing. A plan says what to do on which week, and
 * that is only useful if it respects the hours you actually have - a plan with
 * 180 hours of study in it and no calendar attached is a list, not a plan.
 *
 * Like gap.ts this is pure arithmetic over the local database.
 */
import { estimateMinutes, type GapRow } from './gap.js';

export type PlanItemDraft = {
  skill_id: number;
  skill_name: string;
  from_level: number;
  target_level: number;
  importance: number;
  gap: number;
  priority: number;
  estimate_minutes: number;
  position: number;
  due_date: string | null;
};

export type PlanOptions = {
  /** How many skills to take on. Everything else stays in the gap report. */
  limit?: number;
  /** Realistic study time per week. */
  weeklyMinutes?: number;
  startDate?: string;
  minutesPerPoint?: number;
  /** Ignore gaps at or below this many points - noise, not a plan item. */
  minGap?: number;
  /**
   * Stop short of full proficiency where the role does not demand it. The
   * default targets exactly what the role requires and no more.
   */
  targetOverride?: number;
};

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Build the ordered plan.
 *
 * Ordering is the gap report's own priority ranking (gap weighted by
 * importance), so the first thing you study is the thing whose absence costs
 * the most. Due dates are laid out by spending the weekly budget in sequence:
 * an item that needs three weeks of your available hours lands three weeks out.
 */
export function buildPlan(gaps: GapRow[], options: PlanOptions = {}): PlanItemDraft[] {
  const {
    limit = 8,
    weeklyMinutes = 180,
    startDate = new Date().toISOString().slice(0, 10),
    minutesPerPoint = 30,
    minGap = 5,
    targetOverride,
  } = options;

  const budget = Math.max(30, weeklyMinutes);
  const chosen = gaps.filter((g) => g.gap > minGap).slice(0, Math.max(1, limit));

  let minutesSpent = 0;
  return chosen.map((gap, index) => {
    const target = targetOverride ?? gap.required_level;
    const estimate = estimateMinutes(gap.gap, gap.importance, minutesPerPoint);
    minutesSpent += estimate;
    // Weeks are whole: finishing mid-week still means the deadline is that
    // week, and a date that pretends otherwise invites false precision.
    const weeks = Math.max(1, Math.ceil(minutesSpent / budget));
    return {
      skill_id: gap.skill_id,
      skill_name: gap.name,
      from_level: gap.current_level,
      target_level: target,
      importance: gap.importance,
      gap: gap.gap,
      priority: gap.priority,
      estimate_minutes: estimate,
      position: index,
      due_date: addDays(startDate, weeks * 7),
    };
  });
}

/** Total weeks the plan needs at the given weekly budget. */
export function planDuration(items: PlanItemDraft[], weeklyMinutes: number): {
  total_minutes: number;
  weeks: number;
} {
  const total = items.reduce((sum, item) => sum + item.estimate_minutes, 0);
  return {
    total_minutes: total,
    weeks: total ? Math.max(1, Math.ceil(total / Math.max(30, weeklyMinutes))) : 0,
  };
}

/**
 * Progress across a saved plan, weighted by the study time each item was
 * estimated at - finishing the 20-hour item is not the same as ticking off the
 * 1-hour one, and a plain count would say it was.
 */
export function planProgress(
  items: Array<{ status: string; estimate_minutes: number }>
): { done: number; total: number; percent: number; minutes_done: number; minutes_total: number } {
  const counted = items.filter((i) => i.status !== 'skipped');
  const total = counted.reduce((sum, i) => sum + (i.estimate_minutes || 0), 0);
  const doneItems = counted.filter((i) => i.status === 'done');
  const minutesDone = doneItems.reduce((sum, i) => sum + (i.estimate_minutes || 0), 0);
  return {
    done: doneItems.length,
    total: counted.length,
    percent: total ? Math.round((minutesDone / total) * 100) : 0,
    minutes_done: minutesDone,
    minutes_total: total,
  };
}
