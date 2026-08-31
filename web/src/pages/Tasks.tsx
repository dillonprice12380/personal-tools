import React, { useMemo, useState } from 'react';
import { api, qs, useApi, type ListResponse } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, Stat, Tabs } from '../components/ui';
import { formatDate, minutesToHours, money, num, relativeDay, today } from '../lib/format';

type Task = {
  id: number;
  project_id: number | null;
  list_id: number | null;
  parent_id: number | null;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  priority: number;
  due_date: string | null;
  start_date: string | null;
  estimate_minutes: number;
  recurrence: string;
  tags: Array<{ id: number; name: string; color: string }>;
  subtask_count: number;
  subtasks_done: number;
  comment_count: number;
  tracked_minutes: number;
};

type Project = {
  id: number;
  name: string;
  color: string;
  status: string;
  archived: number;
  client_id: number | null;
  billable: number;
  rate_cents: number;
  due_date: string | null;
  task_count: number;
  open_count: number;
  tracked_minutes: number;
};

const STATUSES: Array<{ id: Task['status']; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
];

const PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];

export function TasksPage() {
  const [projectId, setProjectId] = useState<number | 'all'>('all');
  const [view, setView] = useState<'board' | 'list' | 'today'>('board');
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState('');

  const projects = useApi<ListResponse<Project>>('/projects?archived=0');
  const tasksPath = `/tasks${qs({
    project_id: projectId === 'all' ? '' : projectId,
    q: search,
    parent_id: 'null',
    limit: 500,
  })}`;
  const tasks = useApi<ListResponse<Task>>(tasksPath, [tasksPath]);
  const timer = useApi<any>('/timer');

  const reloadAll = () => {
    void tasks.reload();
    void projects.reload();
    void timer.reload();
  };

  const items = tasks.data?.items ?? [];
  /** Everything open and due on or before today - "My day". */
  const dueToday = useMemo(() => {
    const t = today();
    return items.filter((task) => task.status !== 'done' && task.due_date && task.due_date <= t);
  }, [items]);
  const visible = view === 'today' ? dueToday : items;

  const complete = async (task: Task) => {
    if (task.status === 'done') {
      await api.patch(`/tasks/${task.id}`, { status: 'todo' });
    } else {
      await api.post(`/tasks/${task.id}/complete`);
    }
    reloadAll();
  };

  const move = async (taskId: number, status: Task['status']) => {
    await api.patch(`/tasks/${taskId}`, { status });
    reloadAll();
  };

  return (
    <>
      <header className="topbar">
        <h1>Tasks</h1>
        <select
          value={String(projectId)}
          onChange={(e) => setProjectId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          style={{ width: 200 }}
        >
          <option value="all">All projects</option>
          {(projects.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 200 }}
        />
        <span className="spacer" />
        {timer.data ? (
          <button
            className="btn"
            onClick={async () => {
              await api.post('/timer/stop');
              reloadAll();
            }}
          >
            ⏹ Stop timer
          </button>
        ) : null}
        <button className="btn primary" onClick={() => setComposing(true)}>
          + New task
        </button>
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        <div className="grid cols-4">
          <Card>
            <Stat label="Open" value={num(items.filter((t) => t.status !== 'done').length)} />
          </Card>
          <Card>
            <Stat
              label="Overdue"
              value={
                <span className={items.some((t) => t.status !== 'done' && t.due_date && t.due_date < today()) ? 'neg' : ''}>
                  {num(items.filter((t) => t.status !== 'done' && t.due_date && t.due_date < today()).length)}
                </span>
              }
            />
          </Card>
          <Card>
            <Stat label="Due today" value={num(items.filter((t) => t.status !== 'done' && t.due_date === today()).length)} />
          </Card>
          <Card>
            <Stat
              label="Tracked"
              value={minutesToHours(items.reduce((sum, t) => sum + t.tracked_minutes, 0))}
            />
          </Card>
        </div>

        <Tabs
          tabs={[
            { id: 'board', label: 'Board' },
            { id: 'list', label: 'List' },
            { id: 'today', label: 'My day', count: dueToday.length },
          ]}
          active={view}
          onChange={setView}
        />

        {tasks.error && <Banner tone="error">{tasks.error}</Banner>}

        {view === 'board' ? (
          <div className="board">
            {STATUSES.map((status) => {
              const column = items.filter((t) => t.status === status.id);
              return (
                <BoardColumn
                  key={status.id}
                  label={status.label}
                  count={column.length}
                  onDropTask={(taskId) => move(taskId, status.id)}
                >
                  {column.map((task) => (
                    <TaskCard key={task.id} task={task} onOpen={() => setOpenTask(task.id)} onComplete={() => complete(task)} />
                  ))}
                  {column.length === 0 && <div className="small muted" style={{ padding: 6 }}>Nothing here</div>}
                </BoardColumn>
              );
            })}
          </div>
        ) : (
          <Card padded={false}>
            {visible.length ? (
              <div style={{ padding: '4px 14px 10px' }}>
                {visible.map((task) => (
                  <div className={`task-row ${task.status === 'done' ? 'done' : ''}`} key={task.id}>
                    <button
                      className={`tick ${task.status === 'done' ? 'checked' : ''}`}
                      onClick={() => complete(task)}
                      aria-label={task.status === 'done' ? 'Mark not done' : 'Mark done'}
                    >
                      ✓
                    </button>
                    <span className={`prio prio-${task.priority}`} style={{ height: 20 }} />
                    <button
                      className="title truncate"
                      onClick={() => setOpenTask(task.id)}
                      style={{ background: 'none', border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', padding: 0 }}
                    >
                      {task.title}
                    </button>
                    {task.recurrence && <Chip>↻ {task.recurrence}</Chip>}
                    {task.subtask_count > 0 && (
                      <span className="small muted">
                        {task.subtasks_done}/{task.subtask_count}
                      </span>
                    )}
                    {task.tags.map((tag) => (
                      <Chip key={tag.id} color={tag.color}>{tag.name}</Chip>
                    ))}
                    {task.due_date && (
                      <span className={`small ${task.due_date < today() && task.status !== 'done' ? 'neg' : 'muted'}`}>
                        {relativeDay(task.due_date)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="☑" title={view === 'today' ? 'Nothing due today' : 'No tasks yet'} />
            )}
          </Card>
        )}

        <ProjectsStrip projects={projects.data?.items ?? []} onChanged={reloadAll} />
      </div>

      {composing && (
        <TaskComposer
          projects={projects.data?.items ?? []}
          defaultProject={projectId === 'all' ? null : projectId}
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            reloadAll();
          }}
        />
      )}

      {openTask !== null && (
        <TaskDetail
          taskId={openTask}
          projects={projects.data?.items ?? []}
          onClose={() => setOpenTask(null)}
          onChanged={reloadAll}
        />
      )}
    </>
  );
}

function BoardColumn({
  label,
  count,
  children,
  onDropTask,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  onDropTask: (taskId: number) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`board-col ${over ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = Number(e.dataTransfer.getData('text/plain'));
        if (id) onDropTask(id);
      }}
    >
      <div className="board-col-head">
        {label}
        <span className="muted">{count}</span>
      </div>
      {children}
    </div>
  );
}

function TaskCard({ task, onOpen, onComplete }: { task: Task; onOpen: () => void; onComplete: () => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`task-card ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(task.id));
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={onOpen}
    >
      <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <button
          className={`tick ${task.status === 'done' ? 'checked' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onComplete();
          }}
          aria-label="Toggle done"
        >
          ✓
        </button>
        <span className="title" style={{ flex: 1 }}>{task.title}</span>
      </div>
      <div className="meta">
        <span className={`prio prio-${task.priority}`} style={{ width: 18, height: 3 }} />
        {task.due_date && (
          <span className={task.due_date < today() && task.status !== 'done' ? 'neg' : ''}>
            {relativeDay(task.due_date)}
          </span>
        )}
        {task.subtask_count > 0 && <span>☑ {task.subtasks_done}/{task.subtask_count}</span>}
        {task.comment_count > 0 && <span>💬 {task.comment_count}</span>}
        {task.recurrence && <span>↻</span>}
        {task.tags.map((tag) => (
          <Chip key={tag.id} color={tag.color}>{tag.name}</Chip>
        ))}
      </div>
    </div>
  );
}

function TaskComposer({
  projects,
  defaultProject,
  onClose,
  onSaved,
}: {
  projects: Project[];
  defaultProject: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // project_id is kept as a string because it is bound to a <select>.
  const [form, setForm] = useState({
    title: '',
    project_id: String(defaultProject ?? projects[0]?.id ?? ''),
    priority: 2,
    due_date: '',
    recurrence: '',
    description: '',
  });
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await api.post('/tasks', {
        ...form,
        project_id: form.project_id ? Number(form.project_id) : null,
        due_date: form.due_date || null,
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save');
    }
  };

  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!form.title.trim()}>Create task</button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <Field label="Title">
        <input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Project">
          <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}>
            {PRIORITIES.map((label, i) => (
              <option key={label} value={i}>{label}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="field-row">
        <Field label="Due date">
          <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
        <Field label="Repeats" hint="Creates the next occurrence when completed">
          <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}>
            <option value="">Never</option>
            {['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
    </Modal>
  );
}

function TaskDetail({
  taskId,
  projects,
  onClose,
  onChanged,
}: {
  taskId: number;
  projects: Project[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, reload } = useApi<any>(`/tasks/${taskId}/full`, [taskId]);
  const [comment, setComment] = useState('');
  const [subtask, setSubtask] = useState('');
  const [tag, setTag] = useState('');

  if (!data) return null;

  const patch = async (changes: Record<string, unknown>) => {
    await api.patch(`/tasks/${taskId}`, changes);
    void reload();
    onChanged();
  };

  return (
    <Modal
      title={data.title}
      wide
      onClose={onClose}
      footer={
        <>
          <ConfirmButton
            className="btn danger"
            onConfirm={async () => {
              await api.del(`/tasks/${taskId}`);
              onChanged();
              onClose();
            }}
          >
            Delete
          </ConfirmButton>
          <span className="spacer" />
          <button
            className="btn"
            onClick={async () => {
              await api.post('/timer/start', { task_id: taskId });
              onChanged();
            }}
          >
            ▶ Start timer
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await api.post(`/tasks/${taskId}/complete`);
              onChanged();
              onClose();
            }}
          >
            Mark complete
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Status">
          <select value={data.status} onChange={(e) => patch({ status: e.target.value })}>
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={data.priority} onChange={(e) => patch({ priority: Number(e.target.value) })}>
            {PRIORITIES.map((label, i) => (
              <option key={label} value={i}>{label}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="field-row">
        <Field label="Project">
          <select
            value={String(data.project_id ?? '')}
            onChange={(e) => patch({ project_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" value={data.due_date ?? ''} onChange={(e) => patch({ due_date: e.target.value || null })} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea defaultValue={data.description} onBlur={(e) => patch({ description: e.target.value })} />
      </Field>

      <div className="row wrap">
        {(data.tags ?? []).map((t: any) => (
          <Chip key={t.id} color={t.color}>
            {t.name}
            <button
              className="btn ghost sm"
              style={{ padding: '0 2px' }}
              onClick={async () => {
                await api.del(`/tasks/${taskId}/tags/${t.id}`);
                void reload();
              }}
              aria-label={`Remove ${t.name}`}
            >
              ✕
            </button>
          </Chip>
        ))}
        <input
          placeholder="+ tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && tag.trim()) {
              await api.post(`/tasks/${taskId}/tags`, { name: tag.trim() });
              setTag('');
              void reload();
            }
          }}
          style={{ width: 110 }}
        />
      </div>

      <div>
        <h3 style={{ marginBottom: 6 }}>
          Subtasks {data.subtasks.length > 0 && <span className="muted">{data.subtasks_done}/{data.subtask_count}</span>}
        </h3>
        {data.subtasks.map((sub: Task) => (
          <div className={`task-row ${sub.status === 'done' ? 'done' : ''}`} key={sub.id}>
            <button
              className={`tick ${sub.status === 'done' ? 'checked' : ''}`}
              onClick={async () => {
                await api.patch(`/tasks/${sub.id}`, { status: sub.status === 'done' ? 'todo' : 'done' });
                void reload();
                onChanged();
              }}
              aria-label="Toggle subtask"
            >
              ✓
            </button>
            <span className="title">{sub.title}</span>
          </div>
        ))}
        <input
          placeholder="Add a subtask and press Enter"
          value={subtask}
          onChange={(e) => setSubtask(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && subtask.trim()) {
              await api.post('/tasks', { title: subtask.trim(), parent_id: taskId, project_id: data.project_id });
              setSubtask('');
              void reload();
              onChanged();
            }
          }}
          style={{ marginTop: 6 }}
        />
      </div>

      <div>
        <h3 style={{ marginBottom: 6 }}>
          Comments <span className="muted">· {minutesToHours(data.tracked_minutes)} tracked</span>
        </h3>
        {data.comments.map((c: any) => (
          <div key={c.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <div>{c.body}</div>
            <span className="muted" style={{ fontSize: 11 }}>{formatDate(c.created_at)}</span>
          </div>
        ))}
        <textarea
          placeholder="Add a comment…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ minHeight: 60, marginTop: 6 }}
        />
        <button
          className="btn sm"
          style={{ marginTop: 6 }}
          disabled={!comment.trim()}
          onClick={async () => {
            await api.post('/task-comments', { task_id: taskId, body: comment.trim() });
            setComment('');
            void reload();
          }}
        >
          Comment
        </button>
      </div>
    </Modal>
  );
}

function ProjectsStrip({ projects, onChanged }: { projects: Project[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <Card
      title="Projects"
      actions={
        <button className="btn sm" onClick={() => setAdding(true)}>
          + Project
        </button>
      }
    >
      {projects.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th className="right">Open</th>
                <th className="right">Total</th>
                <th className="right">Tracked</th>
                <th className="right">Value</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="row" style={{ gap: 7 }}>
                      <span className="legend-swatch" style={{ background: p.color }} />
                      {p.name}
                    </span>
                  </td>
                  <td className="right">{p.open_count}</td>
                  <td className="right">{p.task_count}</td>
                  <td className="right">{minutesToHours(p.tracked_minutes)}</td>
                  <td className="right">
                    {p.billable ? money(Math.round((p.tracked_minutes / 60) * p.rate_cents)) : '—'}
                  </td>
                  <td>{p.due_date ? formatDate(p.due_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="◫" title="No projects" hint="Group tasks by client work or internal areas." />
      )}

      {adding && (
        <Modal
          title="New project"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!name.trim()}
                onClick={async () => {
                  await api.post('/projects', { name: name.trim() });
                  setName('');
                  setAdding(false);
                  onChanged();
                }}
              >
                Create
              </button>
            </>
          }
        >
          <Field label="Name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </Modal>
      )}
    </Card>
  );
}
