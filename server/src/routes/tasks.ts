import { Router } from 'express';
import { all, get, logActivity, run, scalar } from '../db.js';
import { crud } from '../lib/crud.js';
import { badRequest, notFound, toInt, wrap } from '../lib/http.js';
import { advance, today, type Cadence } from '../services/recurrence.js';

export const tasksRouter = Router();

const TASK_COLUMNS = [
  'project_id',
  'list_id',
  'parent_id',
  'title',
  'description',
  'status',
  'priority',
  'start_date',
  'due_date',
  'estimate_minutes',
  'position',
  'recurrence',
  'recurrence_until',
  'completed_at',
];

function tagsFor(taskId: number) {
  return all(
    `SELECT t.id, t.name, t.color FROM tags t
       JOIN task_tags tt ON tt.tag_id = t.id
      WHERE tt.task_id = ? ORDER BY t.name`,
    [taskId]
  );
}

function hydrateTask(row: any) {
  if (!row) return row;
  return {
    ...row,
    tags: tagsFor(row.id),
    subtask_count: scalar<number>('SELECT COUNT(*) FROM tasks WHERE parent_id = ?', [row.id], 0),
    subtasks_done: scalar<number>(
      `SELECT COUNT(*) FROM tasks WHERE parent_id = ? AND status = 'done'`,
      [row.id],
      0
    ),
    comment_count: scalar<number>('SELECT COUNT(*) FROM task_comments WHERE task_id = ?', [row.id], 0),
    tracked_minutes: scalar<number>(
      'SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE task_id = ?',
      [row.id],
      0
    ),
  };
}

// ------------------------------------------------------------- projects ----
tasksRouter.use(
  '/projects',
  crud({
    table: 'projects',
    columns: [
      'name',
      'description',
      'color',
      'client_id',
      'status',
      'billable',
      'rate_cents',
      'budget_cents',
      'due_date',
      'archived',
      'position',
    ],
    required: ['name'],
    filters: ['status', 'client_id', 'archived'],
    search: ['name', 'description'],
    orderBy: 'archived ASC, position ASC, id DESC',
    describe: (r) => r?.name ?? '',
    hydrate: (row) => ({
      ...row,
      task_count: scalar<number>('SELECT COUNT(*) FROM tasks WHERE project_id = ?', [row.id], 0),
      open_count: scalar<number>(
        `SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status != 'done'`,
        [row.id],
        0
      ),
      tracked_minutes: scalar<number>(
        'SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE project_id = ?',
        [row.id],
        0
      ),
    }),
  })
);

/** Project roll-up: progress, time, and billable value to date. */
tasksRouter.get(
  '/projects/:id/summary',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const project = get<any>('SELECT * FROM projects WHERE id = ?', [id]);
    if (!project) throw notFound('Project');
    const byStatus = all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status',
      [id]
    );
    const minutes = scalar<number>(
      'SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE project_id = ?',
      [id],
      0
    );
    const billableMinutes = scalar<number>(
      'SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE project_id = ? AND billable = 1',
      [id],
      0
    );
    res.json({
      project,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      tracked_minutes: minutes,
      billable_minutes: billableMinutes,
      billable_value_cents: Math.round((billableMinutes / 60) * project.rate_cents),
      overdue: scalar<number>(
        `SELECT COUNT(*) FROM tasks
          WHERE project_id = ? AND status != 'done' AND due_date IS NOT NULL AND due_date < date('now')`,
        [id],
        0
      ),
    });
  })
);

tasksRouter.use(
  '/task-lists',
  crud({
    table: 'task_lists',
    columns: ['project_id', 'name', 'position'],
    required: ['project_id', 'name'],
    filters: ['project_id'],
    orderBy: 'position ASC, id ASC',
    describe: (r) => r?.name ?? '',
  })
);

// ---------------------------------------------------------------- tasks ----
tasksRouter.use(
  '/tasks',
  crud({
    table: 'tasks',
    columns: TASK_COLUMNS,
    required: ['title'],
    filters: ['project_id', 'list_id', 'status', 'priority', 'parent_id'],
    search: ['title', 'description'],
    orderBy: `CASE status WHEN 'done' THEN 1 ELSE 0 END, position ASC, priority ASC, id DESC`,
    describe: (r) => r?.title ?? '',
    hydrate: hydrateTask,
    beforeWrite: (data, _req, existing) => {
      data.updated_at = new Date().toISOString();
      // Keep completed_at consistent with status without the client having to.
      if (data.status === 'done' && !existing?.completed_at) {
        data.completed_at = new Date().toISOString();
      }
      if (data.status && data.status !== 'done') data.completed_at = null;
    },
  })
);

/** Task detail with its children, comments, tags and time entries. */
tasksRouter.get(
  '/tasks/:id/full',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const task = get<any>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Task');
    res.json({
      ...hydrateTask(task),
      subtasks: all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, id', [id]).map(
        hydrateTask
      ),
      comments: all('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at', [id]),
      time_entries: all('SELECT * FROM time_entries WHERE task_id = ? ORDER BY started_at DESC', [
        id,
      ]),
    });
  })
);

/**
 * Complete a task. A recurring task spawns its next occurrence instead of
 * simply closing, so the series keeps running.
 */
tasksRouter.post(
  '/tasks/:id/complete',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const task = get<any>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) throw notFound('Task');

    run(`UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
    let nextTask: any = null;

    if (task.recurrence) {
      const base = task.due_date || today();
      const nextDue = advance(base, task.recurrence as Cadence);
      const withinWindow = !task.recurrence_until || nextDue <= task.recurrence_until;
      if (withinWindow) {
        const info = run(
          `INSERT INTO tasks (project_id, list_id, parent_id, title, description, status,
                              priority, start_date, due_date, estimate_minutes, position,
                              recurrence, recurrence_until)
           VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)`,
          [
            task.project_id,
            task.list_id,
            task.parent_id,
            task.title,
            task.description,
            task.priority,
            task.start_date ? advance(task.start_date, task.recurrence as Cadence) : null,
            nextDue,
            task.estimate_minutes,
            task.position,
            task.recurrence,
            task.recurrence_until,
          ]
        );
        nextTask = get('SELECT * FROM tasks WHERE id = ?', [Number(info.lastInsertRowid)]);
        // Carry tags across to the new occurrence.
        for (const tag of tagsFor(id) as any[]) {
          run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [
            Number(info.lastInsertRowid),
            tag.id,
          ]);
        }
      }
    }

    logActivity('tasks', id, 'complete', task.title);
    res.json({ task: hydrateTask(get('SELECT * FROM tasks WHERE id = ?', [id])), next: nextTask });
  })
);

/** Bulk reorder / move between lists and statuses (drag and drop). */
tasksRouter.post(
  '/tasks/reorder',
  wrap((req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items)) throw badRequest('items must be an array');
    for (const item of items) {
      const id = toInt(item.id);
      if (!id) continue;
      run(
        `UPDATE tasks SET position = ?,
            list_id = COALESCE(?, list_id),
            status = COALESCE(?, status),
            completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, datetime('now'))
                                WHEN ? IS NOT NULL THEN NULL ELSE completed_at END,
            updated_at = datetime('now')
         WHERE id = ?`,
        [
          toInt(item.position, 0),
          item.list_id ?? null,
          item.status ?? null,
          item.status ?? null,
          item.status ?? null,
          id,
        ]
      );
    }
    res.json({ updated: items.length });
  })
);

/** Everything due (or overdue) in a window - powers the calendar and My Day. */
tasksRouter.get(
  '/tasks-agenda',
  wrap((req, res) => {
    const from = String(req.query.from ?? today());
    const to = String(req.query.to ?? from);
    res.json({
      due: all(
        `SELECT t.*, p.name AS project_name, p.color AS project_color
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.due_date BETWEEN ? AND ? AND t.status != 'done'
          ORDER BY t.due_date, t.priority`,
        [from, to]
      ),
      overdue: all(
        `SELECT t.*, p.name AS project_name, p.color AS project_color
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.due_date < ? AND t.status != 'done'
          ORDER BY t.due_date, t.priority`,
        [from]
      ),
    });
  })
);

// ----------------------------------------------------------------- tags ----
tasksRouter.use(
  '/tags',
  crud({
    table: 'tags',
    columns: ['name', 'color'],
    required: ['name'],
    search: ['name'],
    orderBy: 'name ASC',
    describe: (r) => r?.name ?? '',
  })
);

tasksRouter.post(
  '/tasks/:id/tags',
  wrap((req, res) => {
    const taskId = toInt(req.params.id);
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw badRequest('name is required');
    let tag = get<any>('SELECT * FROM tags WHERE name = ?', [name]);
    if (!tag) {
      const info = run('INSERT INTO tags (name, color) VALUES (?, ?)', [
        name,
        req.body?.color ?? '#94a3b8',
      ]);
      tag = get('SELECT * FROM tags WHERE id = ?', [Number(info.lastInsertRowid)]);
    }
    run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [taskId, tag.id]);
    res.status(201).json(tagsFor(taskId));
  })
);

tasksRouter.delete(
  '/tasks/:id/tags/:tagId',
  wrap((req, res) => {
    run('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?', [
      toInt(req.params.id),
      toInt(req.params.tagId),
    ]);
    res.status(204).end();
  })
);

// ------------------------------------------------------------- comments ----
tasksRouter.use(
  '/task-comments',
  crud({
    table: 'task_comments',
    columns: ['task_id', 'body'],
    required: ['task_id', 'body'],
    filters: ['task_id'],
    orderBy: 'created_at ASC',
  })
);

// ----------------------------------------------------------- time entries --
tasksRouter.use(
  '/time-entries',
  crud({
    table: 'time_entries',
    columns: [
      'task_id',
      'project_id',
      'started_at',
      'ended_at',
      'minutes',
      'note',
      'billable',
      'rate_cents',
      'invoiced',
    ],
    filters: ['task_id', 'project_id', 'billable', 'invoiced'],
    orderBy: 'started_at DESC',
    sortable: ['started_at', 'minutes', 'id'],
  })
);

/** The single running timer, if any. */
tasksRouter.get(
  '/timer',
  wrap((_req, res) => {
    res.json(
      get('SELECT * FROM time_entries WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1') ??
        null
    );
  })
);

tasksRouter.post(
  '/timer/start',
  wrap((req, res) => {
    const running = get<any>('SELECT * FROM time_entries WHERE ended_at IS NULL');
    if (running) throw badRequest('A timer is already running - stop it first');
    const taskId = req.body?.task_id ? toInt(req.body.task_id) : null;
    const task = taskId ? get<any>('SELECT * FROM tasks WHERE id = ?', [taskId]) : null;
    const projectId = req.body?.project_id ? toInt(req.body.project_id) : task?.project_id ?? null;
    const project = projectId ? get<any>('SELECT * FROM projects WHERE id = ?', [projectId]) : null;
    const info = run(
      `INSERT INTO time_entries (task_id, project_id, started_at, note, billable, rate_cents)
       VALUES (?, ?, datetime('now'), ?, ?, ?)`,
      [
        taskId,
        projectId,
        req.body?.note ?? '',
        project?.billable ?? 0,
        project?.rate_cents ?? 0,
      ]
    );
    res.status(201).json(get('SELECT * FROM time_entries WHERE id = ?', [Number(info.lastInsertRowid)]));
  })
);

tasksRouter.post(
  '/timer/stop',
  wrap((_req, res) => {
    const running = get<any>('SELECT * FROM time_entries WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1');
    if (!running) throw badRequest('No timer is running');
    run(
      `UPDATE time_entries
          SET ended_at = datetime('now'),
              minutes = MAX(1, CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER))
        WHERE id = ?`,
      [running.id]
    );
    res.json(get('SELECT * FROM time_entries WHERE id = ?', [running.id]));
  })
);
