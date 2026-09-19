"use client";
import Link from "next/link";
import { useState } from "react";
import type { Dashboard, TaskListItem } from "./lib/types";
import { useResource, invalidate } from "./lib/data";
import { request, errorMessage } from "./lib/api";
import { clock, deadline, duration } from "./lib/presentation";
import {
  CapacityWarning,
  CourseChip,
  Empty,
  ErrorBox,
  PriorityBadge,
  Skeleton,
} from "./components/ui";
import { CheckSquare, Clock, GraduationCap, Play } from "lucide-react";

// The next class may be on a later day (e.g. Monday, seen on a Sunday).
function classDay(start: string, now: string, zone: string) {
  const day = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(new Date(iso));
  return day(start, { dateStyle: "short" }) === day(now, { dateStyle: "short" })
    ? null
    : day(start, { weekday: "short" });
}

export default function DashboardPage() {
  const { data, loading, error, refresh } =
    useResource<Dashboard>("/dashboard");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");

  async function complete(t: TaskListItem) {
    setBusy(t.id);
    setActionError("");
    try {
      await request(
        `/tasks/${t.id}/${t.status === "COMPLETED" ? "reopen" : "complete"}`,
        "POST",
      );
      invalidate();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  if (!data)
    return (
      <div className="animate-in fade-in">
        <div className="page-heading dashboard-heading">
          <h1>Dashboard</h1>
        </div>
        <ErrorBox message={error} retry={refresh} />
        {loading && <Skeleton rows={5} />}
      </div>
    );

  const zone = data.date.timezone;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="page-heading dashboard-heading">
        <div>
          <h1>Dashboard</h1>
          <p className="today-date">
            {new Intl.DateTimeFormat("en-GB", {
              timeZone: zone,
              weekday: "long",
              day: "numeric",
              month: "long",
            }).format(new Date(data.date.now))}
            {data.profile.academicWeek !== null && ` · Week ${data.profile.academicWeek}`}
          </p>
        </div>
      </div>

      <ErrorBox message={error || actionError} retry={refresh} />
      
      <section className="summary-grid" aria-label="Daily summary">
        <div className="summary-card" style={{ background: '#Edf4e2', border: 'none' }}>
          <span className="summary-icon" style={{ background: '#dce8c5', color: '#4a622a' }}>
            <CheckSquare size={24} strokeWidth={2.5} />
          </span>
          <div>
            <strong style={{ color: '#4a622a' }}>{data.summary.tasksToday}</strong>
            <p style={{ fontWeight: 600, color: '#4a622a' }}>Tasks today</p>
            <small style={{ color: '#688243' }}>
              {data.summary.highPriority ? `${data.summary.highPriority} high priority` : "Nothing urgent"}
            </small>
          </div>
        </div>
        <div className="summary-card" style={{ background: '#fff0db', border: 'none' }}>
          <span className="summary-icon" style={{ background: '#ffe0b2', color: '#a85f09' }}>
            <Clock size={24} strokeWidth={2.5} />
          </span>
          <div>
            <strong style={{ color: '#a85f09' }}>{duration(data.summary.plannedStudyMinutes)}</strong>
            <p style={{ fontWeight: 600, color: '#a85f09' }}>Study planned</p>
            <small style={{ color: '#c07e2c' }}>
              {data.summary.plannedStudyMinutes
                ? "In today’s study blocks"
                : "No study blocks today"}
            </small>
          </div>
        </div>
        <div className="summary-card" style={{ background: '#fcebe9', border: 'none' }}>
          <span className="summary-icon" style={{ background: '#f6d5cf', color: '#ab3925' }}>
            <GraduationCap size={24} strokeWidth={2.5} />
          </span>
          <div>
            <p style={{ fontWeight: 600, color: '#ab3925' }}>
              {data.nextClass?.inProgress ? "Class in progress" : "Next class"}
            </p>
            <strong className="class-title" style={{ color: '#ab3925', fontSize: '20px' }}>
              {data.nextClass?.title ?? "No upcoming classes"}
            </strong>
            <small style={{ color: '#c45846', fontWeight: 600 }}>
              {data.nextClass
                ? [classDay(data.nextClass.start, data.date.now, zone), clock(data.nextClass.start, zone), data.nextClass.location]
                    .filter(Boolean)
                    .join(" · ")
                : <Link href="/setup#sources" className="text-link">Add your timetable</Link>}
            </small>
          </div>
        </div>
      </section>

      <div className="dashboard-grid" style={{ gap: '32px', marginTop: '32px' }}>
        <section>
          <div className="panel-heading">
            <h2>Today’s Priorities</h2>
            <Link className="text-link" href="/tasks">
              View all →
            </Link>
          </div>
          <div className="priority-list" style={{ background: 'var(--surface)', borderRadius: '16px', border: '1px solid var(--line)', overflow: 'hidden' }}>
            {data.priorities.map((t) => (
              <article className="priority-row" key={t.id} style={{ borderBottom: '1px solid var(--line)', margin: 0, padding: '16px 20px' }}>
                <input
                  type="checkbox"
                  aria-label={`Mark ${t.title} ${t.status === "COMPLETED" ? "open" : "complete"}`}
                  checked={t.status === "COMPLETED"}
                  disabled={busy === t.id}
                  onChange={() => void complete(t)}
                />
                <div className="priority-main">
                  <div className="task-line">
                    <CourseChip task={t} />
                    <Link
                      className={`task-title ${t.status === "COMPLETED" ? "completed" : ""}`}
                      href={`/tasks?task=${t.id}`}
                      style={{ fontSize: '15px' }}
                    >
                      {t.title}
                    </Link>
                  </div>
                  <p className="muted tiny" style={{ fontSize: '13px' }}>
                    {t.status === "COMPLETED"
                      ? "Completed today"
                      : [t.deadline ? `Due ${deadline(t.deadline, zone)}` : "No deadline", t.estimatedMinutes ? duration(t.estimatedMinutes) : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="priority-actions">
                  <PriorityBadge task={t} />
                  {t.status === "OPEN" && (
                    <Link
                      className="button secondary small"
                      href={`/tasks?task=${t.id}`}
                    >
                      Open Task
                    </Link>
                  )}
                </div>
              </article>
            ))}
            {data.completedToday.length > 0 && (
              <p className="muted tiny" style={{ padding: '12px 20px', margin: 0 }}>
                <Link href="/tasks" className="text-link">
                  {data.completedToday.length} completed today ✓
                </Link>
              </p>
            )}
            {!data.priorities.length && !data.completedToday.length && (
              <div style={{ padding: '24px' }}>
                <Empty title="Nothing due soon.">
                  New Classroom work will appear here after a sync.
                </Empty>
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="panel-heading">
            <h2>Today’s Schedule</h2>
            <Link
              className="text-link"
              href={`/planner?day=${data.date.today}&mode=day`}
            >
              View full day →
            </Link>
          </div>
          <div style={{ background: 'var(--surface)', borderRadius: '16px', border: '1px solid var(--line)', padding: '20px' }}>
            <ol className="schedule-list">
              {data.todaySchedule.map((item) => (
                <li
                  key={item.id}
                  className={`${item.isNext ? "next" : ""} ${item.isPast ? "past" : ""}`}
                  style={{ minHeight: '60px' }}
                >
                  <span className="schedule-dot" style={{ marginTop: '6px' }} />
                  <time style={{ fontWeight: 600, fontSize: '13px' }}>{clock(item.start, zone)}</time>
                  <div style={{ marginTop: '-2px' }}>
                    {item.taskId ? (
                      <Link
                        className="task-title"
                        href={`/tasks?task=${item.taskId}`}
                        style={{ fontSize: '14px' }}
                      >
                        {item.title}
                      </Link>
                    ) : (
                      <strong style={{ fontSize: '14px' }}>{item.title}</strong>
                    )}
                    <p style={{ fontSize: '13px' }}>
                      {item.location ??
                        (item.kind === "STUDY"
                          ? "Self-study block"
                          : (item.classType ?? item.kind.toLowerCase()))}
                    </p>
                  </div>
                  {(item.isCurrent || item.isNext) && (
                    <span className="badge warm">
                      {item.isCurrent ? "Now" : "Next"}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {!data.todaySchedule.length && (
              <Empty title="Nothing scheduled today.">
                Study blocks appear here when tasks have deadlines.
              </Empty>
            )}
            
            <Link className="button ghost wide" href="/tasks" style={{ marginTop: '16px' }}>
              <Play size={14} /> Start a focus session
            </Link>
          </div>
        </section>
      </div>
      
      <CapacityWarning capacity={data.capacity} />
    </div>
  );
}
