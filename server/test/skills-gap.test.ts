import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseGaps,
  clampLevel,
  estimateMinutes,
  proficiencyLabel,
  readiness,
  summarise,
  type SkillRequirement,
} from '../src/services/skills/gap.js';
import { buildPlan, planDuration, planProgress } from '../src/services/skills/plan.js';

const requirement = (over: Partial<SkillRequirement> = {}): SkillRequirement => ({
  skill_id: 1,
  code: 'starter:seo',
  name: 'SEO',
  category: 'Marketing',
  importance: 50,
  required_level: 60,
  current_level: 40,
  assessed_on: '2026-01-01',
  ...over,
});

test('a gap is the shortfall against the required level, never negative', () => {
  const [row] = analyseGaps([requirement({ required_level: 80, current_level: 30 })]);
  assert.equal(row.gap, 50);
  assert.equal(row.surplus, 0);

  const [over] = analyseGaps([requirement({ required_level: 40, current_level: 90 })]);
  assert.equal(over.gap, 0);
  assert.equal(over.surplus, 50);
  assert.equal(over.status, 'met');
});

test('ranking weights the gap by how much the role depends on the skill', () => {
  // A bigger hole in something peripheral must not outrank a smaller hole in
  // the thing the role is built on.
  const rows = analyseGaps([
    requirement({ skill_id: 1, name: 'Peripheral', importance: 20, required_level: 100, current_level: 50 }),
    requirement({ skill_id: 2, name: 'Core', importance: 100, required_level: 80, current_level: 50 }),
  ]);
  assert.equal(rows[0].name, 'Core');
  assert.equal(rows[0].priority, 30); // 30 gap x 1.00
  assert.equal(rows[1].priority, 10); // 50 gap x 0.20
});

test('status bands follow the size of the gap', () => {
  const status = (required: number, current: number) =>
    analyseGaps([requirement({ required_level: required, current_level: current })])[0].status;
  assert.equal(status(60, 60), 'met');
  assert.equal(status(60, 55), 'close');
  assert.equal(status(60, 40), 'gap');
  assert.equal(status(90, 20), 'critical');
});

test('never assessed is distinguished from assessed at zero', () => {
  const [unassessed] = analyseGaps([requirement({ current_level: 0, assessed_on: null })]);
  const [atZero] = analyseGaps([requirement({ current_level: 0, assessed_on: '2026-02-02' })]);
  assert.equal(unassessed.unassessed, true);
  assert.equal(atZero.unassessed, false);
  assert.equal(unassessed.gap, atZero.gap);
});

test('readiness is importance-weighted coverage, and surplus does not offset a gap', () => {
  const met = analyseGaps([requirement({ required_level: 60, current_level: 60 })]);
  assert.equal(readiness(met), 100);

  const half = analyseGaps([requirement({ required_level: 80, current_level: 40 })]);
  assert.equal(readiness(half), 50);

  // Expert in the peripheral skill, absent in the core one: the excess in the
  // first must not paper over the hole in the second.
  const lopsided = analyseGaps([
    requirement({ skill_id: 1, importance: 100, required_level: 80, current_level: 0 }),
    requirement({ skill_id: 2, importance: 100, required_level: 20, current_level: 100 }),
  ]);
  assert.equal(readiness(lopsided), 20); // (0 + 20) / (80 + 20)
});

test('readiness is null - not zero - when the role has no requirements loaded', () => {
  assert.equal(readiness([]), null);
});

test('levels arriving from an import are clamped into 0-100', () => {
  assert.equal(clampLevel(-30), 0);
  assert.equal(clampLevel(140), 100);
  assert.equal(clampLevel('not a number'), 0);
  assert.equal(clampLevel(61.6), 62);
});

test('proficiency labels snap to the rung at or below the level', () => {
  assert.equal(proficiencyLabel(0), 'None');
  assert.equal(proficiencyLabel(35), 'Novice');
  assert.equal(proficiencyLabel(60), 'Competent');
  assert.equal(proficiencyLabel(100), 'Expert');
});

test('study estimates scale with the gap and stay on half-hour boundaries', () => {
  assert.equal(estimateMinutes(0, 50), 0);
  const small = estimateMinutes(10, 50);
  const large = estimateMinutes(40, 50);
  assert.ok(large > small);
  assert.equal(large % 30, 0);
  // Importance nudges the same gap upward, it does not dominate it.
  assert.ok(estimateMinutes(20, 100) > estimateMinutes(20, 0));
});

test('summary counts met, outstanding and critical requirements', () => {
  const rows = analyseGaps([
    requirement({ skill_id: 1, required_level: 40, current_level: 60 }),
    requirement({ skill_id: 2, required_level: 80, current_level: 20 }),
    requirement({ skill_id: 3, required_level: 60, current_level: 55 }),
  ]);
  const summary = summarise(rows);
  assert.equal(summary.requirements, 3);
  assert.equal(summary.met, 1);
  assert.equal(summary.gaps, 2);
  assert.equal(summary.critical, 1);
  assert.ok(summary.total_gap_minutes > 0);
});

test('a plan takes the highest-priority gaps and schedules them in order', () => {
  const rows = analyseGaps([
    requirement({ skill_id: 1, name: 'Low', importance: 20, required_level: 50, current_level: 40 }),
    requirement({ skill_id: 2, name: 'High', importance: 100, required_level: 90, current_level: 20 }),
    requirement({ skill_id: 3, name: 'Met', importance: 90, required_level: 30, current_level: 80 }),
  ]);
  const plan = buildPlan(rows, { limit: 5, weeklyMinutes: 180, startDate: '2026-01-01' });

  assert.equal(plan.length, 2, 'the already-met skill is not a plan item');
  assert.equal(plan[0].skill_name, 'High');
  assert.equal(plan[0].position, 0);
  assert.equal(plan[0].target_level, 90);
  // Due dates are cumulative: later steps are never scheduled earlier.
  assert.ok(plan[1].due_date! >= plan[0].due_date!);
});

test('plan length respects the weekly time budget', () => {
  const rows = analyseGaps([
    requirement({ skill_id: 1, importance: 100, required_level: 100, current_level: 0 }),
  ]);
  const roomy = planDuration(buildPlan(rows, { weeklyMinutes: 600 }), 600);
  const tight = planDuration(buildPlan(rows, { weeklyMinutes: 60 }), 60);
  assert.equal(roomy.total_minutes, tight.total_minutes);
  assert.ok(tight.weeks > roomy.weeks, 'fewer hours a week means more weeks');
});

test('plan progress is weighted by study time, not by item count', () => {
  const progress = planProgress([
    { status: 'done', estimate_minutes: 900 },
    { status: 'todo', estimate_minutes: 100 },
    { status: 'skipped', estimate_minutes: 9000 },
  ]);
  assert.equal(progress.total, 2, 'skipped items leave the denominator');
  assert.equal(progress.done, 1);
  assert.equal(progress.percent, 90);
});
