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
  Icon,
  PriorityBadge,
  Skeleton,
} from "../components/ui";
import { TaskDetail } from "../components/task-detail";
import { TaskForm, taskTypes } from "../components/task-form";
import { useStudent } from "../components/shell";
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
  const select = (id: string) =>
    router.replace(`/tasks?task=${encodeURIComponent(id)}`, { scroll: false });
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
    <>
      <div className="page-heading between">
        <div>
          <h1>Tasks</h1>
          <p>Manage your coursework and deadlines.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={17} />
          New Task
        </button>
      </div>
      <div className="tasks-toolbar">
        <div className="pills" aria-label="Filter tasks">
          {[
            ["all", "All", "all"],
            ["upcoming", "Upcoming", "upcoming"],
            ["high_priority", "High Priority", "highPriority"],
            ["completed", "Completed", "completed"],
          ].map(([v, label, key]) => (
            <button
              key={v}
              aria-pressed={view === v}
              className={view === v ? "selected" : ""}
              onClick={() => setView(v)}
            >
              {label}{" "}
              {list.data
                ? `(${list.data.counts[key as keyof TaskList["counts"]]})`
                : ""}
            </button>
          ))}
        </div>
        <div className="search-controls">
          <label className="search">
            <Icon name="search" size={17} />
            <input
              aria-label="Search tasks"
              maxLength={100}
              placeholder="Search tasks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button
            className="icon-button bordered"
            aria-label="Task filters"
            aria-expanded={filters}
            onClick={() => setFilters(!filters)}
          >
            <Icon name="filter" size={17} />
          </button>
        </div>
      </div>
      {filters && (
        <div className="filter-panel">
          <label>
            Course
            <input
              placeholder="Course name or ID"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
            />
          </label>
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {taskTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="priority">Priority</option>
              <option value="deadline">Deadline</option>
              <option value="updated">Recently updated</option>
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={bookmarked}
              onChange={(e) => setBookmarked(e.target.checked)}
            />
            Bookmarked only
          </label>
          <button
            className="text-button"
            onClick={() => {
              setCourse("");
              setType("");
              setBookmarked(false);
              setSort("priority");
            }}
          >
            Clear filters
          </button>
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
                className={`task-list-item ${selected === t.id ? "selected" : ""}`}
              >
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
                />
                <button
                  className="task-select"
                  onClick={() => select(t.id)}
                  aria-pressed={selected === t.id}
                >
                  <div className="task-line">
                    <CourseChip task={t} />
                    <strong
                      className={t.status === "COMPLETED" ? "completed" : ""}
                    >
                      {t.title}
                    </strong>
                  </div>
                  <p className="muted tiny">
                    {t.status === "COMPLETED"
                      ? "Completed"
                      : `${deadline(t.deadline, timezone)} · ${duration(t.estimatedMinutes)}`}
                  </p>
                </button>
                <PriorityBadge task={t} />
              </article>
            ))
          )}
          {!list.loading && list.data?.tasks.length === 0 && (
            <Empty
              title={
                q || course || type
                  ? "No matching tasks."
                  : "You’re all caught up."
              }
            >
              {q || course || type
                ? "Try another search or clear your filters."
                : "Add a task or connect an academic source to get started."}
            </Empty>
          )}
        </section>
        {selected ? (
          <TaskDetail
            key={selected}
            id={selected}
            onDeleted={() => router.replace("/tasks")}
          />
        ) : (
          <section className="card task-detail">
            <Empty title="A little focus goes a long way.">
              Select a task to see its checklist, notes, attachments, and study
              progress.
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
    </>
  );
}
