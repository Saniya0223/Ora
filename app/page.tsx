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
  Icon,
  PriorityBadge,
  Progress,
  Skeleton,
} from "./components/ui";
import { useFocus } from "./components/focus";
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
      <>
        <div className="page-heading">
          <h1>Your academic day</h1>
          <p>A little clarity for everything ahead.</p>
        </div>
        <ErrorBox message={error} retry={refresh} />
        {loading && <Skeleton rows={5} />}
      </>
    );
  const zone = data.date.timezone;
  const hour = Number(clock(data.date.now, zone).slice(0, 2));
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return (
    <>
      <div className="page-heading intro">
        <div>
          <h1>
            {greeting}, {data.profile.name.split(" ")[0]}{" "}
            <span className="wave" aria-hidden="true">
              ☀
            </span>
          </h1>
          <p className="today-date">
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
        <div className="quote">
          <Icon name="leaf" />
          <em>“Progress over perfection.”</em>
        </div>
      </div>
      <ErrorBox message={error || actionError} retry={refresh} />
      <section className="summary-grid" aria-label="Daily summary">
        <div className="summary-card">
          <span className="summary-icon green">
            <Icon name="task" size={28} />
          </span>
          <div>
            <strong>{data.summary.tasksToday}</strong>
            <p>Tasks today</p>
            <small>{data.summary.highPriority} high priority</small>
          </div>
        </div>
        <div className="summary-card">
          <span className="summary-icon orange">
            <Icon name="clock" size={28} />
          </span>
          <div>
            <strong>{duration(data.summary.plannedStudyMinutes)}</strong>
            <p>Study planned</p>
            <small>
              {data.summary.plannedStudyMinutes
                ? "You’ve made room for progress."
                : "Your next step starts here."}
            </small>
          </div>
        </div>
        <div className="summary-card">
          <span className="summary-icon rose">
            <Icon name="cap" size={28} />
          </span>
          <div>
            <p>
              {data.nextClass?.inProgress ? "Class in progress" : "Next class"}
            </p>
            <strong className="class-title">
              {data.nextClass?.title ?? "No upcoming classes"}
            </strong>
            <small className="accent-text">
              {data.nextClass
                ? [clock(data.nextClass.start, zone), data.nextClass.location]
                    .filter(Boolean)
                    .join(" · ")
                : "Add your timetable in Setup"}
            </small>
          </div>
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="card">
          <div className="panel-heading">
            <h2>Today’s Priorities</h2>
            <Link className="text-link" href="/tasks">
              View all →
            </Link>
          </div>
          <div className="priority-list">
            {[...data.priorities, ...data.completedToday].map((t) => (
              <article className="priority-row" key={t.id}>
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
                    >
                      {t.title}
                    </Link>
                  </div>
                  <p className="muted tiny">
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
              <Empty title="A little breathing room.">
                No priorities today.{" "}
                <Link href="/tasks">Explore your tasks</Link> or add a notice.
              </Empty>
            )}
          </div>
        </section>
        <section className="card">
          <div className="panel-heading">
            <h2>Today’s Schedule</h2>
            <Link
              className="text-link"
              href={`/planner?day=${data.date.today}&mode=day`}
            >
              View full day →
            </Link>
          </div>
          <ol className="schedule-list">
            {data.todaySchedule.map((item) => (
              <li
                key={item.id}
                className={`${item.isNext ? "next" : ""} ${item.isPast ? "past" : ""}`}
              >
                <span className="schedule-dot" />
                <time>{clock(item.start, zone)}</time>
                <div>
                  {item.taskId ? (
                    <Link
                      className="task-title"
                      href={`/tasks?task=${item.taskId}`}
                    >
                      {item.title}
                    </Link>
                  ) : (
                    <strong>{item.title}</strong>
                  )}
                  <p>
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
          <Link className="button focus wide" href="/tasks">
            <Icon name="play" size={15} /> Start Focus Session
          </Link>
        </section>
      </div>
      <CapacityWarning capacity={data.capacity} />
    </>
  );
}
