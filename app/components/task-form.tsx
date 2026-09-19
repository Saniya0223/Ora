"use client";
import { useState } from "react";
import type { TaskDetail, TaskInput, TaskType, Priority } from "../lib/types";
import { request, errorMessage } from "../lib/api";
import { invalidate } from "../lib/data";
import { localInput } from "../lib/presentation";
import { useStudent } from "./shell";
import { ErrorBox, Modal } from "./ui";
export const taskTypes: TaskType[] = [
  "EXAM",
  "ASSIGNMENT",
  "LAB",
  "LECTURE",
  "ADMIN",
  "CLUB",
  "OTHER",
];
export function TaskForm({
  task,
  onClose,
  onSaved,
}: {
  task?: TaskDetail;
  onClose: () => void;
  onSaved: (t: TaskDetail) => void;
}) {
  const { timezone } = useStudent();
  const [title, setTitle] = useState(task?.title ?? "");
  const [course, setCourse] = useState(task?.course?.name ?? "");
  const [type, setType] = useState<TaskType>(task?.type ?? "OTHER");
  const [due, setDue] = useState(localInput(task?.deadline ?? null, timezone));
  const [estimate, setEstimate] = useState(
    task?.studentEstimatedMinutes?.toString() ?? "",
  );
  const [priority, setPriority] = useState(task?.manualPriorityOverride ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const body: TaskInput = {};
    if (!task || estimate !== (task.studentEstimatedMinutes?.toString() ?? ""))
      body.estimatedMinutes = estimate === "" ? null : Number(estimate);
    if (!task || priority !== (task.manualPriorityOverride ?? ""))
      body.manualPriorityOverride = (priority || null) as Priority | null;
    if (!task || notes !== task.notes) body.notes = notes;
    if (!task?.isSourceBacked) {
      if (!task || title !== task.title) body.title = title.trim();
      if (!task || course !== (task.course?.name ?? ""))
        body.courseName = course.trim() || null;
      if (!task || type !== task.type) body.type = type;
      if (!task || due !== localInput(task.deadline, timezone))
        body.deadline = due || null;
    }
    try {
      if (!Object.keys(body).length) {
        onClose();
        return;
      }
      const r = await request<{ task: TaskDetail }>(
        task ? `/tasks/${task.id}` : "/tasks",
        task ? "PATCH" : "POST",
        body,
      );
      invalidate();
      onSaved(r.task);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={task ? "Edit Task" : "New Task"} onClose={onClose}>
      <form onSubmit={save} className="form-stack">
        <ErrorBox message={error} />
        {task?.isSourceBacked && (
          <p className="message">
            Title, course, type, and deadline are managed by the academic
            source. You can change your estimate, priority, and notes.
          </p>
        )}
        <label>
          Title
          <input
            autoFocus
            required
            maxLength={300}
            value={title}
            disabled={task?.isSourceBacked || busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            Course
            <input
              maxLength={100}
              value={course}
              disabled={task?.isSourceBacked || busy}
              onChange={(e) => setCourse(e.target.value)}
            />
          </label>
          <label>
            Type
            <select
              value={type}
              disabled={task?.isSourceBacked || busy}
              onChange={(e) => setType(e.target.value as TaskType)}
            >
              {taskTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Deadline ({timezone})
            <input
              type="datetime-local"
              value={due}
              disabled={task?.isSourceBacked || busy}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          <label>
            Your effort estimate (minutes)
            <input
              type="number"
              min={1}
              max={10000}
              step={1}
              placeholder="Unknown / use source estimate"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </label>
        </div>
        <label>
          Priority
          <select
            aria-label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority | "")}
          >
            <option value="">Automatic</option>
            {["HIGH", "MEDIUM", "LOW"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <textarea
            maxLength={20000}
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="button-row end">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !title.trim()}>
            {busy ? "Saving…" : task ? "Save changes" : "Create Task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
