/**
 * Skills gap analysis.
 *
 * Everything here is arithmetic over rows from the local skills database. No
 * model call, no network: a gap report for a role with 40 requirements is one
 * join and a sort, which is why it can run on every page load for free.
 *
 * All levels are integers on a 0-100 scale. Sources normalise into it on
 * import (see onet.ts), so nothing downstream has to know that O*NET rates
 * importance 1-5 and level 0-7.
 */

/**
 * The proficiency ladder shown in the UI. Six rungs rather than a free slider:
 * a self-assessment is a judgement, and pretending it resolves to single
 * percentage points would dress it up as a measurement.
 */
export type ProficiencyRung = { value: number; label: string; hint: string };

export const PROFICIENCY: ProficiencyRung[] = [
  { value: 0, label: 'None', hint: 'Never used it' },
  { value: 20, label: 'Novice', hint: 'Followed a tutorial' },
  { value: 40, label: 'Advanced beginner', hint: 'Works with help' },
  { value: 60, label: 'Competent', hint: 'Works unsupervised' },
  { value: 80, label: 'Proficient', hint: 'Handles the awkward cases' },
  { value: 100, label: 'Expert', hint: 'Others ask you' },
];

export function proficiencyLabel(level: number): string {
  let best = PROFICIENCY[0];
  for (const rung of PROFICIENCY) if (level >= rung.value) best = rung;
  return best.label;
}

/** Clamp anything arriving from an import or a form into 0-100. */
export function clampLevel(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export type SkillRequirement = {
  skill_id: number;
  code: string;
  name: string;
  category: string;
  search_terms?: string;
  /** How much the role depends on this skill, 0-100. */
  importance: number;
  /** Proficiency the role calls for, 0-100. */
  required_level: number;
  /** Latest self-assessment, 0-100. Absent means never assessed. */
  current_level: number;
  assessed_on?: string | null;
};

export type GapStatus = 'met' | 'close' | 'gap' | 'critical';

export type GapRow = SkillRequirement & {
  /** Shortfall in proficiency points, never negative. */
  gap: number;
  /** Proficiency held beyond what the role needs. */
  surplus: number;
  /** gap weighted by importance, 0-100. The ranking key. */
  priority: number;
  status: GapStatus;
  /** Never assessed, as opposed to assessed at zero - a different problem. */
  unassessed: boolean;
};

function statusFor(gap: number): GapStatus {
  if (gap <= 0) return 'met';
  if (gap <= 10) return 'close';
  if (gap <= 25) return 'gap';
  return 'critical';
}

/**
 * Rank a role's requirements by what is worth learning next.
 *
 *   gap      = required - current, floored at zero
 *   priority = gap x (importance / 100)
 *
 * Weighting by importance is the whole point: a 40-point hole in something the
 * role barely touches should not outrank a 20-point hole in the thing it is
 * built on.
 */
export function analyseGaps(rows: SkillRequirement[]): GapRow[] {
  return rows
    .map((row) => {
      const required = clampLevel(row.required_level);
      const current = clampLevel(row.current_level);
      const importance = clampLevel(row.importance);
      const gap = Math.max(0, required - current);
      return {
        ...row,
        importance,
        required_level: required,
        current_level: current,
        gap,
        surplus: Math.max(0, current - required),
        priority: Math.round(gap * (importance / 100)),
        status: statusFor(gap),
        unassessed: row.assessed_on === null || row.assessed_on === undefined,
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        b.importance - a.importance ||
        b.gap - a.gap ||
        a.name.localeCompare(b.name)
    );
}

/**
 * Importance-weighted coverage of a role, 0-100.
 *
 *   readiness = 100 x SUM(importance x min(current, required))
 *                   / SUM(importance x required)
 *
 * Capping the numerator at `required` is deliberate: being an expert in
 * something the role wants at "competent" is not spare credit that offsets a
 * hole somewhere else.
 *
 * Returns null when the role has no requirements at all - that is "no profile
 * loaded", which is a different thing from "0% ready" and should not be
 * rendered as one.
 */
export function readiness(rows: GapRow[]): number | null {
  let have = 0;
  let need = 0;
  for (const row of rows) {
    have += row.importance * Math.min(row.current_level, row.required_level);
    need += row.importance * row.required_level;
  }
  if (need <= 0) return null;
  return Math.round((have / need) * 100);
}

/**
 * Rough study time for closing a gap, in minutes.
 *
 * This is a planning constant, not a measurement - it exists so a plan can lay
 * itself out across a calendar, and `minutesPerPoint` is a setting precisely
 * because the honest default is "it depends". 30 minutes per proficiency point
 * puts one rung of the ladder (20 points) at about 10 hours.
 *
 * Importance nudges it up a little: the skills a role leans on get studied more
 * thoroughly, not just to the same nominal level.
 */
export function estimateMinutes(gap: number, importance = 50, minutesPerPoint = 30): number {
  if (gap <= 0) return 0;
  const weighted = gap * minutesPerPoint * (0.75 + (clampLevel(importance) / 100) * 0.5);
  // Round to a half hour; nobody schedules 47 minutes of study.
  const rounded = Math.round(weighted / 30) * 30;
  return Math.max(30, Math.min(6000, rounded));
}

export type GapSummary = {
  readiness: number | null;
  requirements: number;
  assessed: number;
  met: number;
  gaps: number;
  critical: number;
  total_gap_minutes: number;
};

export function summarise(rows: GapRow[], minutesPerPoint = 30): GapSummary {
  return {
    readiness: readiness(rows),
    requirements: rows.length,
    assessed: rows.filter((r) => !r.unassessed).length,
    met: rows.filter((r) => r.status === 'met').length,
    gaps: rows.filter((r) => r.status !== 'met').length,
    critical: rows.filter((r) => r.status === 'critical').length,
    total_gap_minutes: rows.reduce(
      (sum, r) => sum + estimateMinutes(r.gap, r.importance, minutesPerPoint),
      0
    ),
  };
}
