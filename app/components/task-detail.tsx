"use client";
import { useState } from "react";
import type {
  Attachment,
  ChecklistItem,
  TaskDetail as Detail,
} from "../lib/types";
import { request, uploadFile, errorMessage } from "../lib/api";
import { useResource, invalidate } from "../lib/data";
import { deadline, duration } from "../lib/presentation";
import {
  CourseChip,
  ErrorBox,
  Icon,
  PriorityBadge,
  Progress,
  Skeleton,
  Modal,
} from "./ui";
import { TaskForm } from "./task-form";
import { useStudent } from "./shell";
import { useFocus } from "./focus";
import { TaskSourceDetails } from "./task-source-details";
export function TaskDetail({
  id,
  onDeleted,
}: {
  id: string;
  onDeleted: () => void;
}) {
  const { data, error, loading, refresh } = useResource<{ task: Detail }>(
    `/tasks/${encodeURIComponent(id)}`,
  );
  const task = data?.task;
  const [tab, setTab] = useState("Checklist");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const { timezone } = useStudent();
  const focus = useFocus();
  async function action(suffix: string, method = "POST", body?: unknown) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await request(`/tasks/${id}${suffix}`, method, body);
      invalidate();
      if (method === "DELETE" && !suffix) onDeleted();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card task-detail" aria-label="Task details">
      <ErrorBox message={error || actionError} retry={refresh} />
      {loading && !task && <Skeleton rows={5} />}{" "}
      {task && (
        <>
          <div className="detail-top">
            <div className="button-row">
              <CourseChip task={task} />
              <PriorityBadge task={task} />
            </div>
            <div className="button-row">
              <button
                className={`icon-button ${task.bookmarked ? "bookmarked" : ""}`}
                aria-label={
                  task.bookmarked ? "Remove bookmark" : "Bookmark task"
                }
                aria-pressed={task.bookmarked}
                disabled={busy}
                onClick={() =>
                  void action("/bookmark", "PUT", {
                    bookmarked: !task.bookmarked,
                  })
                }
              >
                <Icon name="bookmark" size={18} />
              </button>
              {!task.isSourceBacked && (
                <details className="more-menu">
                  <summary aria-label="More task actions">•••</summary>
                  <button onClick={() => setDeleting(true)}>Delete task</button>
                </details>
              )}
            </div>
          </div>
          <h2 className="detail-title">{task.title}</h2>
          <p
            className={`detail-deadline ${task.isOverdue ? "accent-text" : ""}`}
          >
            <Icon name="clock" size={15} />
            {deadline(task.deadline, timezone)}
            {task.isOverdue ? " · Overdue" : ""}
          </p>
          <p className="muted tiny">
            {task.source.replaceAll("_", " ").toLowerCase()}
            {task.isSourceBacked ? " · Source-managed task" : ""}
            {task.sourceStatus === "CANCELLED" ? " · Source cancelled" : ""}
          </p>
          <TaskSourceDetails task={task} timezone={timezone} />
          <div className="effort-grid">
            <div>
              <span className="mini-icon">
                <Icon name="clock" />
              </span>
              <div>
                <small>Estimated effort</small>
                <p>{duration(task.estimatedMinutes)}</p>
                {task.estimatedMinutes === null && (
                  <button
                    className="text-button tiny"
                    disabled={busy}
                    onClick={() => void action("/estimate")}
                  >
                    {busy ? "Estimating…" : "Estimate effort"}
                  </button>
                )}
              </div>
            </div>
            <div>
              <span className="mini-icon">
                <Icon name="task" />
              </span>
              <div>
                <small>Study time</small>
                <p>
                  {duration(task.actualMinutes)} /{" "}
                  {task.estimatedMinutes === null
                    ? "Unknown"
                    : duration(task.estimatedMinutes)}
                </p>
                <Progress value={task.progress.timePercent} />
              </div>
            </div>
          </div>
          {task.aiEstimate && (
            <details className="estimate-details">
              <summary>About the effort estimate</summary>
              <p>{task.aiEstimate.rationale}</p>
              <ul>
                {task.aiEstimate.workUnits.map((u, i) => (
                  <li key={i}>
                    {u.title} · {duration(u.minutes)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="detail-tabs" role="tablist" aria-label="Task content">
            {["Checklist", "Notes", "Attachments"].map((t) => (
              <button
                key={t}
                role="tab"
                id={`tab-${t}`}
                aria-controls={`panel-${t}`}
                aria-selected={tab === t}
                onClick={() => setTab(t)}
              >
                {t}
                {t === "Attachments" && task.attachmentCount > 0
                  ? ` (${task.attachmentCount})`
                  : ""}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="tab-content"
          >
            {tab === "Checklist" && <TaskChecklist task={task} />}{" "}
            {tab === "Notes" && <TaskNotes key={task.id} task={task} />}{" "}
            {tab === "Attachments" && <TaskAttachments task={task} />}
          </div>
          <button
            className="button focus wide"
            disabled={task.status !== "OPEN" || focus.busy}
            onClick={() => void focus.start(task.id)}
          >
            <Icon name="clock" size={16} />
            Start Focus (Pomodoro 25m)
          </button>
          <div className="detail-actions">
            <button
              className="button secondary"
              onClick={() => setEditing(true)}
            >
              <Icon name="edit" size={16} />
              Edit Task
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                task.status === "CANCELLED" ||
                (task.status === "COMPLETED" &&
                  task.sourceStatus === "CANCELLED")
              }
              onClick={() =>
                void action(
                  task.status === "COMPLETED" ? "/reopen" : "/complete",
                )
              }
            >
              <Icon name="check" size={16} />
              {task.status === "COMPLETED" ? "Reopen" : "Mark Complete"}
            </button>
          </div>
          {editing && (
            <TaskForm
              task={task}
              onClose={() => setEditing(false)}
              onSaved={() => refresh()}
            />
          )}{" "}
          {deleting && (
            <Modal title="Delete this task?" onClose={() => setDeleting(false)}>
              <p>
                This removes the manual task, its attachments, and future study
                blocks. Focus history is kept.
              </p>
              <div className="button-row end">
                <button
                  className="button secondary"
                  onClick={() => setDeleting(false)}
                >
                  Keep task
                </button>
                <button
                  className="button focus"
                  disabled={busy}
                  onClick={() => void action("", "DELETE")}
                >
                  Delete task
                </button>
              </div>
            </Modal>
          )}
        </>
      )}
    </section>
  );
}
function TaskChecklist({ task }: { task: Detail }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function change(path: string, method: string, body?: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request(`/tasks/${task.id}/checklist${path}`, method, body);
      if (method === "POST") setText("");
      invalidate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorBox message={error} />
      <p className="tiny muted checklist-count">
        {task.checklistProgress.done} of {task.checklistProgress.total} steps
        completed
      </p>
      <ul className="checklist">
        {task.checklist.map((item) => (
          <ChecklistRow
            key={item.id}
            item={item}
            busy={busy}
            onChange={(body) => change(`/${item.id}`, "PATCH", body)}
            onDelete={() => change(`/${item.id}`, "DELETE")}
          />
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void change("", "POST", { text: text.trim() });
        }}
      >
        <input
          aria-label="New subtask"
          placeholder="Add a subtask…"
          maxLength={300}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="icon-button"
          disabled={busy || !text.trim()}
          aria-label="Add subtask"
        >
          <Icon name="plus" size={18} />
        </button>
      </form>
    </>
  );
}
function ChecklistRow({
  item,
  busy,
  onChange,
  onDelete,
}: {
  item: ChecklistItem;
  busy: boolean;
  onChange: (body: { text?: string; done?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  return (
    <li>
      <input
        type="checkbox"
        aria-label={item.text}
        checked={item.done}
        disabled={busy}
        onChange={() => void onChange({ done: !item.done })}
      />
      {editing ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void onChange({ text: text.trim() }).then(() => setEditing(false));
          }}
        >
          <input
            aria-label="Edit subtask"
            maxLength={300}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="text-button" disabled={busy || !text.trim()}>
            Save
          </button>
        </form>
      ) : (
        <button
          className={`checklist-text ${item.done ? "completed" : ""}`}
          title="Edit subtask"
          onClick={() => {
            setText(item.text);
            setEditing(true);
          }}
        >
          {item.text}
        </button>
      )}
      <button
        className="icon-button subtle"
        aria-label={`Delete ${item.text}`}
        disabled={busy}
        onClick={() => void onDelete()}
      >
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}
function TaskNotes({ task }: { task: Detail }) {
  const [notes, setNotes] = useState(task.notes);
  const [saved, setSaved] = useState(task.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await request(`/tasks/${task.id}/notes`, "PUT", { notes });
          setSaved(notes);
          invalidate();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox message={error} />
      <label className="sr-only" htmlFor="task-notes">
        Task notes
      </label>
      <textarea
        id="task-notes"
        rows={7}
        maxLength={20000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Keep useful details here…"
      />
      <div className="button-row between">
        <span className="tiny muted">
          {notes === saved ? "Notes saved" : "Unsaved changes"}
        </span>
        <button
          className="button secondary small"
          disabled={busy || notes === saved}
        >
          {busy ? "Saving…" : "Save notes"}
        </button>
      </div>
    </form>
  );
}
function TaskAttachments({ task }: { task: Detail }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const mime =
        file.type ||
        (file.name.endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "");
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Choose a file no larger than 10 MB.");
      setStatus("Preparing upload…");
      const r = await request<{
        attachment: Attachment;
        upload: { url: string; fields: Record<string, string> };
      }>(`/tasks/${task.id}/attachments`, "POST", {
        fileName: file.name,
        contentType: mime,
        size: file.size,
      });
      setStatus("Uploading file…");
      await uploadFile(r.upload, file);
      setStatus("Confirming file…");
      await request(
        `/tasks/${task.id}/attachments/${r.attachment.id}/confirm`,
        "POST",
      );
      setStatus("Attachment saved.");
      invalidate();
    } catch (e) {
      setError(errorMessage(e));
      invalidate();
    } finally {
      setBusy(false);
    }
  }
  async function act(a: Attachment, action: "download" | "delete" | "confirm") {
    setBusy(true);
    setError("");
    try {
      const path = `/tasks/${task.id}/attachments/${a.id}`;
      if (action === "download") {
        const r = await request<{ url: string }>(`${path}/download`);
        const link = document.createElement("a");
        link.href = r.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.click();
      } else {
        await request(
          action === "confirm" ? `${path}/confirm` : path,
          action === "confirm" ? "POST" : "DELETE",
        );
        invalidate();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorBox message={error} />
      <ul className="attachment-list">
        {task.attachments.map((a) => (
          <li key={a.id}>
            <div>
              <strong>{a.fileName}</strong>
              <small>
                {Math.ceil(a.size / 1024)} KB ·{" "}
                {a.status === "READY"
                  ? "Ready"
                  : "Upload awaiting confirmation"}
              </small>
            </div>
            <button
              className="icon-button"
              disabled={busy}
              aria-label={`${a.status === "READY" ? "Download" : "Confirm"} ${a.fileName}`}
              onClick={() =>
                void act(a, a.status === "READY" ? "download" : "confirm")
              }
            >
              <Icon
                name={a.status === "READY" ? "download" : "refresh"}
                size={16}
              />
            </button>
            <button
              className="icon-button"
              disabled={busy}
              aria-label={`Delete attachment ${a.fileName}`}
              onClick={() => void act(a, "delete")}
            >
              <Icon name="close" size={15} />
            </button>
          </li>
        ))}
      </ul>
      <label className="file-button">
        <Icon name="upload" size={16} />
        {busy ? status : "Add attachment"}
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.txt,.docx"
          disabled={busy || task.attachments.length >= 20}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </label>
      <p className="tiny muted">
        PDF, images, text, or Word · up to 10 MB each
      </p>
      {status && !busy && (
        <p className="tiny" role="status">
          {status}
        </p>
      )}
    </>
  );
}
