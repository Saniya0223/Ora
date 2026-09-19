"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import type { Capacity, TaskListItem } from "../lib/types";
export function Icon({
  name = "calendar",
  size = 20,
}: {
  name?: string;
  size?: number;
}) {
  const paths: Record<string, React.ReactNode> = {
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 10h18m-14 4h3m4 0h3m-10 4h3" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    cap: (
      <>
        <path d="m2 8 10-5 10 5-10 5-10-5Zm4 2v7l6 3 6-3v-7m4-2v8" />
      </>
    ),
    task: (
      <>
        <rect x="5" y="5" width="14" height="16" rx="2" />
        <path d="M9 5V3h6v2m-7 9 3 3 5-6" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    bookmark: <path d="M6 21V4h12v17l-6-4-6 4Z" />,
    edit: <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" />,
    upload: <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />,
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />,
    refresh: <path d="M20 8a9 9 0 1 0 0 8M20 3v5h-5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    check: <path d="m4 12 5 5L20 6" />,
    filter: <path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6" />,
    bulb: <path d="M9 18h6m-6 3h6M8 15a7 7 0 1 1 8 0v3H8v-3Z" />,
    leaf: <path d="M19 3C3 2 3 18 12 18c7 0 7-9 7-15ZM7 21 16 8" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.calendar}
    </svg>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return message ? (
    <div className="message error" role="alert">
      <span>{message}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          Try again
        </button>
      )}
      {/profile/i.test(message) && (
        <Link href="/setup#profile">Set up profile</Link>
      )}
    </div>
  ) : null;
}
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="skeletons">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name="leaf" size={28} />
      <h3>{title}</h3>
      <div className="muted">{children}</div>
    </div>
  );
}
export function PriorityBadge({ task }: { task: TaskListItem }) {
  const label =
    task.status === "COMPLETED"
      ? "Completed"
      : task.status === "CANCELLED"
        ? "Cancelled"
        : task.effectivePriority === "HIGH"
          ? "High Priority"
          : task.effectivePriority === "MEDIUM"
            ? "Upcoming"
            : "Normal";
  return (
    <span
      className={`badge ${task.status === "COMPLETED" ? "success" : task.effectivePriority === "HIGH" && task.status === "OPEN" ? "danger" : "neutral"}`}
    >
      {label}
    </span>
  );
}
export function CourseChip({ task }: { task: TaskListItem }) {
  return task.course?.name ? (
    <span className="course-chip" title={task.course.name}>
      {task.course.name}
    </span>
  ) : (
    <span className="course-chip">{task.type.toLowerCase()}</span>
  );
}
export function Progress({ value }: { value: number | null }) {
  return value === null ? (
    <span className="muted tiny">Estimate pending</span>
  ) : (
    <div className="progress-wrap">
      <progress aria-label="Study time progress" max={100} value={value} />
      <span>{value}%</span>
    </div>
  );
}
export function CapacityWarning({ capacity }: { capacity: Capacity | null }) {
  return capacity &&
    (capacity.atRisk ||
      capacity.unestimatedTasks.length > 0 ||
      capacity.deferred.length > 0) ? (
    <aside className="message warning" aria-label="Planning needs attention">
      <strong>
        {capacity.atRisk ? "Some work needs more time" : "Planning notes"}
      </strong>
      {capacity.items.map((i) => (
        <p key={i.taskId}>
          <Link href={`/tasks?task=${i.taskId}`}>{i.message}</Link>
        </p>
      ))}
      {capacity.unestimatedTasks.length > 0 && (
        <p>
          {capacity.unestimatedTasks.length} task(s) need an effort estimate
          before they can be scheduled. <Link href="/tasks">Review tasks</Link>
        </p>
      )}
      {capacity.deferred.length > 0 && (
        <p>
          {capacity.deferred.length} task(s) fall beyond the 14-day planning
          horizon.
        </p>
      )}
    </aside>
  ) : null;
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    el?.addEventListener("cancel", onCancel);
    return () => {
      el?.removeEventListener("cancel", onCancel);
      el?.close();
    };
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-label={title}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
