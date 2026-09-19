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
  Progress,
  Skeleton,
} from "./components/ui";
import { useFocus } from "./components/focus";
import { CheckSquare, Clock, GraduationCap, Play } from "lucide-react";

export default function DashboardPage() {
  const { data, loading, error, refresh } =
    useResource<Dashboard>("/dashboard");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const focus = useFocus();

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
        <div className="page-heading">
          <h1>Your academic day</h1>
          <p>A little clarity for everything ahead.</p>
        </div>
        <ErrorBox message={error} retry={refresh} />
        {loading && <Skeleton rows={5} />}
      </div>
    );

  const zone = data.date.timezone;
  const hour = Number(clock(data.date.now, zone).slice(0, 2));
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="page-heading intro" style={{ marginBottom: '32px' }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {greeting}, {data.profile.name.split(" ")[0]}{" "}
            <span className="wave" aria-hidden="true" style={{ fontSize: '32px' }}>
              👋
            </span>
          </h1>
          <p className="today-date" style={{ fontWeight: 600, color: 'var(--ink)' }}>
            {new Intl.DateTimeFormat("en-GB", {
              timeZone: zone,
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            }).format(new Date(data.date.now))}
          </p>
          <span className="muted">
            {[
              data.profile.academicWeek !== null
                ? `Week ${data.profile.academicWeek}`
                : null,
              data.profile.semester,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
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
            <small style={{ color: '#688243' }}>{data.summary.highPriority} high priority</small>
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
                ? "You’ve made room for progress."
                : "Your next step starts here."}
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
                ? [clock(data.nextClass.start, zone), data.nextClass.location]
                    .filter(Boolean)
                    .join(" · ")
                : "Add your timetable in Setup"}
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
            {[...data.priorities, ...data.completedToday].map((t) => (
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
                      : `${deadline(t.deadline, zone)} · ${duration(t.estimatedMinutes)}`}
                  </p>
                  {t.status === "OPEN" && (
                    <Progress value={t.progress.timePercent} />
                  )}
                </div>
                <div className="priority-actions">
                  <PriorityBadge task={t} />
                  {t.status === "OPEN" &&
                    (t.effectivePriority === "HIGH" ? (
                      <button
                        className="button focus small"
                        disabled={focus.busy}
                        onClick={() => void focus.start(t.id)}
                      >
                        Start Focus
                      </button>
                    ) : (
                      <Link
                        className="button secondary small"
                        href={`/tasks?task=${t.id}`}
                      >
                        Open Task
                      </Link>
                    ))}
                </div>
              </article>
            ))}
            {!data.priorities.length && !data.completedToday.length && (
              <div style={{ padding: '24px' }}>
                <Empty title="A little breathing room.">
                  No priorities today.{" "}
                  <Link href="/tasks" className="text-link">Explore your tasks</Link> or add a notice.
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
              <Empty title="Your day is open.">
                Import classes or add task estimates to build your schedule.
              </Empty>
            )}
            
            <Link className="button focus wide" href="/tasks" style={{ marginTop: '16px' }}>
              <Play size={16} fill="currentColor" /> Start Focus Session
            </Link>
          </div>
        </section>
      </div>
      
      <CapacityWarning capacity={data.capacity} />
    </div>
  );
}
