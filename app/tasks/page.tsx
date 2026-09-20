"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { TaskList, TaskListItem } from "../lib/types";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import { duration, deadline } from "../lib/presentation";
import {
  CourseChip,
  Empty,
  ErrorBox,
  PriorityBadge,
  Skeleton,
  Modal,
} from "../components/ui";
import { TaskDetail } from "../components/task-detail";
import { TaskForm, taskTypes } from "../components/task-form";
import { useStudent } from "../components/shell";
import { Plus, Search, Filter, Lightbulb } from "lucide-react";

export default function TasksPage() {
  return (
    <Suspense fallback={<Skeleton rows={5} />}>
      <Tasks />
    </Suspense>
  );
}
function Tasks() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("task");
  const [view, setView] = useState("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState(false);
  const [course, setCourse] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState("priority");
  const [bookmarked, setBookmarked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteAll, setDeleteAll] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletingAll, setDeletingAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { timezone } = useStudent();
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = new URLSearchParams({ view, sort });
  if (q) query.set("q", q);
  if (course) query.set("course", course);
  if (type) query.set("type", type);
  if (bookmarked) query.set("bookmarked", "true");
  const list = useResource<TaskList>(`/tasks?${query}`);
  useEffect(() => {
    if (!selected && list.data?.tasks.length) {
      router.replace(
        `/tasks?task=${encodeURIComponent(list.data.tasks[0].id)}`,
        { scroll: false },
      );
    }
  }, [selected, list.data, router]);
  const select = (id: string) => {
    router.replace(`/tasks?task=${encodeURIComponent(id)}`, { scroll: false });
    // On narrow screens the detail sits below the list; bring it into view.
    if (window.matchMedia("(max-width: 900px)").matches)
      setTimeout(() => document.querySelector(".task-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  async function toggle(t: TaskListItem) {
    setBusy(t.id);
    setError("");
    try {
      await request(
        `/tasks/${t.id}/${t.status === "COMPLETED" ? "reopen" : "complete"}`,
        "POST",
      );
      invalidate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="page-heading between" style={{ marginBottom: '32px' }}>
        <div>
          <h1>Tasks</h1>
          <p>Manage your coursework and deadlines.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)} style={{ padding: '12px 20px', fontSize: '14px' }}>
          <Plus size={18} strokeWidth={2.5} />
          New Task
        </button>
      </div>
      <div className="tasks-toolbar" style={{ background: 'var(--surface)', padding: '16px', borderRadius: '16px', border: '1px solid var(--line)' }}>
        <div className="pills" aria-label="Filter tasks">
          {[
            ["all", "All", "all"],
            ["upcoming", "Upcoming", "upcoming"],
            ["high_priority", "High priority", "highPriority"],
            ["completed", "Completed", "completed"],
          ].map(([v, label, key]) => (
            <button
              key={v}
              aria-pressed={view === v}
              className={view === v ? "selected" : ""}
              onClick={() => setView(v)}
              style={view === v ? { background: 'var(--olive)', color: 'white', borderRadius: '12px' } : { background: 'transparent', borderRadius: '12px', color: 'var(--muted)' }}
            >
              {label}{" "}
              {list.data
                ? <span style={{ opacity: 0.7, marginLeft: '4px' }}>{list.data.counts[key as keyof TaskList["counts"]]}</span>
                : ""}
            </button>
          ))}
        </div>
        <div className="search-controls">
          <label className="search" style={{ borderRadius: '12px', background: '#f5efe5', border: 'none' }}>
            <Search size={18} />
            <input
              aria-label="Search tasks"
              maxLength={100}
              placeholder="Search tasks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ fontSize: '14px' }}
            />
          </label>
          <button
            className={`icon-button bordered ${filters ? 'active' : ''}`}
            aria-label="Task filters"
            aria-expanded={filters}
            onClick={() => setFilters(!filters)}
            style={{ borderRadius: '12px', background: filters ? '#e1eacb' : 'transparent', borderColor: filters ? 'transparent' : '#e4dcd1' }}
          >
            <Filter size={18} />
          </button>
        </div>
      </div>
      {filters && (
        <div className="filter-panel animate-in fade-in slide-in-from-top-2" style={{ background: 'var(--surface)', padding: '20px', borderRadius: '16px', border: '1px solid var(--line)', marginBottom: '20px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          <label style={{ flex: 1, minWidth: '150px' }}>
            Course
            <input
              placeholder="Course name or ID"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
            />
          </label>
          <label style={{ flex: 1, minWidth: '150px' }}>
            Type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {taskTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: '150px' }}>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="priority">Priority</option>
              <option value="deadline">Deadline</option>
              <option value="updated">Recently updated</option>
            </select>
          </label>
          <label className="check-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '24px' }}>
            <input
              type="checkbox"
              checked={bookmarked}
              onChange={(e) => setBookmarked(e.target.checked)}
            />
            Bookmarked only
          </label>
          <button
            className="text-button"
            style={{ marginTop: '24px' }}
            onClick={() => {
              setCourse("");
              setType("");
              setBookmarked(false);
              setSort("priority");
            }}
          >
            Clear filters
          </button>
          <button className="text-button tiny" style={{ marginTop: '24px', marginLeft: 'auto', color: 'var(--muted)' }} onClick={() => setDeleteAll(true)}>Delete all tasks…</button>
        </div>
      )}
      <ErrorBox message={error || list.error} retry={list.refresh} />
      <div className="tasks-grid">
        <section
          className="task-list"
          aria-label="Tasks"
          aria-busy={list.loading}
        >
          {list.loading && !list.data ? (
            <Skeleton rows={5} />
          ) : (
            list.data?.tasks.map((t) => (
              <article
                key={t.id}
                className={`task-list-item ${selected === t.id ? "selected" : ""} ${t.status !== "OPEN" ? "is-done" : ""}`}
                style={{
                  borderRadius: '16px',
                  border: selected === t.id ? '2px solid var(--olive)' : '1px solid var(--line)',
                  padding: '20px',
                  transition: 'all 0.2s ease',
                  cursor: 'pointer',
                  boxShadow: selected === t.id ? '0 4px 12px rgba(82, 99, 59, 0.08)' : 'none'
                }}
                onClick={() => select(t.id)}
              >
                <div onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Mark ${t.title} ${t.status === "COMPLETED" ? "open" : "complete"}`}
                    checked={t.status === "COMPLETED"}
                    disabled={
                      busy === t.id ||
                      t.status === "CANCELLED" ||
                      t.sourceStatus === "CANCELLED"
                    }
                    onChange={() => void toggle(t)}
                    style={{ width: '20px', height: '20px' }}
                  />
                </div>
                <div className="task-select" style={{ cursor: 'pointer' }}>
                  <div className="task-line">
                    <CourseChip task={t} />
                    <strong
                      className={t.status === "COMPLETED" ? "completed" : ""}
                      style={{ fontSize: '15px' }}
                    >
                      {t.title}
                    </strong>
                    {t.recentSourceChange && <span className="source-update-badge" title={`Source updated ${deadline(t.recentSourceChange.at, timezone)}`}>{t.recentSourceChange.label}</span>}
                  </div>
                  <p className="muted tiny" style={{ fontSize: '13px', marginTop: '8px' }}>
                    {t.status === "COMPLETED"
                      ? "Completed"
                      : t.status === "CANCELLED"
                        ? "Cancelled"
                        : [t.deadline ? `Due ${deadline(t.deadline, timezone)}` : "No deadline", t.estimatedMinutes ? duration(t.estimatedMinutes) : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {t.status === "OPEN" && <PriorityBadge task={t} />}
              </article>
            ))
          )}
          {!list.loading && list.data?.tasks.length === 0 && (
            <div style={{ background: 'var(--surface)', padding: '40px 20px', borderRadius: '16px', border: '1px solid var(--line)', textAlign: 'center' }}>
              <Lightbulb size={32} color="var(--olive)" style={{ margin: '0 auto 16px' }} />
              <h3 style={{ marginBottom: '8px', color: 'var(--olive)' }}>
                {q || course || type
                  ? "No matching tasks."
                  : "You’re all caught up."}
              </h3>
              <p className="muted">
                {q || course || type
                  ? "Try another search or clear your filters."
                  : "New Classroom work will appear here after a sync."}
              </p>
            </div>
          )}
        </section>
        {selected ? (
          <TaskDetail
            key={selected}
            id={selected}
            onDeleted={() => router.replace("/tasks")}
          />
        ) : (
          <section className="card task-detail" style={{ borderRadius: '20px', border: '1px solid var(--line)', boxShadow: '0 4px 20px rgba(0,0,0,0.03)' }}>
            <Empty title="Pick a task">
              See what to do, what changed, and when it&rsquo;s due.
            </Empty>
          </section>
        )}
      </div>
      {creating && (
        <TaskForm
          onClose={() => setCreating(false)}
          onSaved={(t) => select(t.id)}
        />
      )}
      {deleteAll && <Modal title="Delete all tasks?" onClose={() => setDeleteAll(false)}>
        <p>This removes all current tasks and future study blocks. Tasks from existing Classroom posts and PDFs will remain hidden on later syncs; new source posts can still create tasks. Focus history is kept.</p>
        <label>Type DELETE ALL TASKS to confirm
          <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" />
        </label>
        <div className="button-row end">
          <button className="button secondary" onClick={() => setDeleteAll(false)}>Keep tasks</button>
          <button className="button focus" disabled={deletingAll || deleteConfirmation !== "DELETE ALL TASKS"} onClick={async () => {
            setDeletingAll(true);
            setError("");
            try {
              await request("/tasks", "DELETE", { confirmation: deleteConfirmation });
              router.replace("/tasks");
              invalidate();
              setDeleteAll(false);
              setDeleteConfirmation("");
            } catch (e) { setError(errorMessage(e)); }
            finally { setDeletingAll(false); }
          }}>{deletingAll ? "Deleting…" : "Delete all tasks"}</button>
        </div>
      </Modal>}
    </div>
  );
}
