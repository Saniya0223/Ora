"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import type { Capacity, TaskListItem } from "../lib/types";
import {
  Calendar,
  Clock,
  GraduationCap,
  CheckSquare,
  Search,
  Plus,
  Play,
  Bookmark,
  Edit2,
  Upload,
  Download,
  RefreshCw,
  X,
  ChevronDown,
  Check,
  Filter,
  Lightbulb,
  Leaf
} from "lucide-react";

export function Icon({
  name = "calendar",
  size = 20,
}: {
  name?: string;
  size?: number;
}) {
  const icons: Record<string, React.FC<any>> = {
    calendar: Calendar,
    clock: Clock,
    cap: GraduationCap,
    task: CheckSquare,
    search: Search,
    plus: Plus,
    play: Play,
    bookmark: Bookmark,
    edit: Edit2,
    upload: Upload,
    download: Download,
    refresh: RefreshCw,
    close: X,
    chevron: ChevronDown,
    check: Check,
    filter: Filter,
    bulb: Lightbulb,
    leaf: Leaf,
  };

  const IconComponent = icons[name] || Calendar;

  return <IconComponent size={size} strokeWidth={2} />;
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
// Only states worth a glance get a badge; ordinary open tasks stay quiet.
export function PriorityBadge({ task }: { task: TaskListItem }) {
  const open = task.status === "OPEN";
  const [label, tone] =
    task.status === "COMPLETED" ? ["Done", "success"]
    : task.status === "CANCELLED" ? ["Cancelled", "neutral"]
    : open && task.isOverdue ? ["Overdue", "danger"]
    : task.effectivePriority === "HIGH" ? ["High priority", "danger"]
    : task.effectivePriority === "MEDIUM" ? ["Upcoming", "neutral"]
    : [null, ""];
  return label ? <span className={`badge ${tone}`}>{label}</span> : null;
}
export function CourseChip({ task }: { task: TaskListItem }) {
  const fromClassroom = task.source === "CLASSROOM";
  const label = task.course?.name ?? task.type.charAt(0) + task.type.slice(1).toLowerCase();
  return (
    <span
      className={`course-chip${fromClassroom ? " from-classroom" : ""}`}
      title={fromClassroom ? `From Google Classroom · ${label}` : label}
    >
      {fromClassroom && <GraduationCap size={11} strokeWidth={2.5} aria-hidden="true" />}
      {label}
    </span>
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
