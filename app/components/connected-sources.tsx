"use client";
import { useState } from "react";
import type { Sources } from "../lib/types";
import { useClassroomSync } from "./classroom-sync";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import { deadline } from "../lib/presentation";
import { safeSourceLink, syncExplanation, syncSummary } from "../lib/source-presentation";
import { RefreshCw } from "lucide-react";
import { useStudent } from "./shell";
import { ErrorBox, Icon, Modal, Skeleton } from "./ui";
export function ConnectedSources({ onTimetable }: { onTimetable: () => void }) {
  const resource = useResource<Sources>("/sources");
  const source = resource.data?.classroom;
  const timetable = resource.data?.timetable;
  const { timezone } = useStudent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const classroomSync = useClassroomSync();
  const [courses, setCourses] = useState<
    { id: string; name: string; section: string }[] | null
  >(null);
  const [selected, setSelected] = useState<string[]>([]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await request<{ url: string }>("/classroom/connect");
      window.location.assign(r.url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  async function choose() {
    setBusy(true);
    setError("");
    try {
      const r = await request<{
        courses: { id: string; name: string; section: string }[];
      }>("/classroom/courses");
      setSelected(source?.selectedCourses.map((c) => c.id) ?? []);
      setCourses(r.courses);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" id="sources">
      <h2>Connected Sources</h2>
      <p className="muted">Where Ora gets your coursework and classes.</p>
      <ErrorBox message={error || resource.error} retry={resource.refresh} />
      {resource.loading && !source && <Skeleton rows={2} />}{" "}
      {source && <ClassroomCard
        source={source}
        syncing={classroomSync.syncing}
        syncError={classroomSync.error}
        busy={busy}
        timezone={timezone}
        onSync={() => {
          setMessage("");
          void classroomSync.sync();
        }}
        onChoose={() => void choose()}
        onConnect={() => void connect()}
      />}
      {timetable && (
        <div className="source-card">
          <span className="source-icon rose">
            <Icon name="calendar" size={25} />
          </span>
          <div className="source-copy">
            <strong>Timetable</strong>
            {timetable.status === "READY" ? (
              <>
                <p>{timetable.slotCount} classes a week</p>
                <small>
                  {timetable.source
                    ? `From ${timetable.source.fileName} · updated ${deadline(timetable.source.updatedAt, timezone)}`
                    : "Added manually"}
                </small>
              </>
            ) : (
              <p>Add your timetable so Ora can plan around your classes.</p>
            )}
          </div>
          <button className="button secondary small" onClick={onTimetable}>
            {timetable.status === "READY" ? "Edit" : "Add"}
          </button>
        </div>
      )}
      {message && (
        <p className="message" role="status">
          {message}
        </p>
      )}
      {courses && (
        <Modal
          title="Choose Classroom courses"
          onClose={() => setCourses(null)}
        >
          <ErrorBox message={error} />
          {courses.length === 0 ? (
            <p>No active courses found for this account.</p>
          ) : (
            <div className="course-options">
              {courses.map((c) => (
                <label className="check-label" key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, c.id]
                          : selected.filter((id) => id !== c.id),
                      )
                    }
                  />
                  <span>
                    {c.name}
                    {c.section ? ` · ${c.section}` : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await request("/classroom/courses", "PUT", {
                  courseIds: selected,
                });
                setCourses(null);
                setMessage(
                  "Courses saved. Sync now to bring in their work.",
                );
                invalidate();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save selected courses"}
          </button>
        </Modal>
      )}
    </section>
  );
}

function ClassroomCard({ source, syncing, syncError, busy, timezone, onSync, onChoose, onConnect }: {
  source: Sources["classroom"];
  syncing: boolean;
  syncError: string;
  busy: boolean;
  timezone: string;
  onSync: () => void;
  onChoose: () => void;
  onConnect: () => void;
}) {
  const connected = source.connection === "CONNECTED";
  const summary = syncing
    ? { tone: "busy" as const, title: "Syncing Classroom…", detail: "Checking for new announcements and coursework", changes: [] }
    : syncError
      ? { tone: "error" as const, title: "Classroom couldn't be synced right now", detail: syncError, changes: [] }
      : syncSummary(source);
  const result = source.sync.lastResult;
  const courseNames = source.selectedCourses.map((c) => c.name ?? "Untitled course").join(", ");
  return (
    <div className="source-card classroom-source">
      <span className="source-icon green">
        <Icon name="cap" size={25} />
      </span>
      <div className="source-copy">
        <div className="source-head">
          <strong>Google Classroom</strong>
          {connected && source.health !== "REAUTH_REQUIRED" && (
            <button
              className="button primary small"
              disabled={busy || syncing}
              onClick={onSync}
            >
              <RefreshCw size={13} className={summary.tone === "busy" ? "spin" : ""} />
              {summary.tone === "busy" ? "Syncing…" : "Sync now"}
            </button>
          )}
        </div>
        <span className="source-status">
          <span className={`status-dot ${connected ? "on" : ""}`} />
          {connected ? "Connected" : "Not connected"}
          {connected && courseNames && <span className="muted"> · {courseNames}</span>}
        </span>
        <div className={`sync-summary ${summary.tone}`} role="status">
          <strong>
            {summary.tone === "busy" ? "⟳" : summary.tone === "ok" ? "✓" : "⚠"} {summary.title}
          </strong>
          {summary.detail && <small>{summary.detail}</small>}
          {summary.changes.length > 0 && (
            <ul>{summary.changes.map((change) => <li key={change}>{change}</li>)}</ul>
          )}
          {summary.tone !== "busy" && result?.reviewItems?.map((item) => {
            const url = safeSourceLink(item.sourceUrl, true);
            const course = source.selectedCourses.find((c) => c.id === item.courseId)?.name ?? "Classroom";
            return url ? (
              <small key={item.sourceRef}>
                {course} post · <a href={url} target="_blank" rel="noopener noreferrer">Review original ↗</a>
              </small>
            ) : null;
          })}
        </div>
        {result && summary.tone !== "busy" && (
          <details className="sync-details">
            <summary>Details</summary>
            <small>
              Checked {result.announcementsScanned} announcements and {result.courseworkScanned} coursework
              items in {result.coursesScanned} course{result.coursesScanned === 1 ? "" : "s"}
              {result.ignored ? ` · ${result.ignored} with nothing to do` : ""}.
              {source.sync.lastFinishedAt ? ` Finished ${deadline(source.sync.lastFinishedAt, timezone)}.` : ""}
            </small>
            {summary.tone !== "ok" && <small>{syncExplanation(result)}</small>}
          </details>
        )}
        <div className="button-row source-actions">
          {connected && (
            <button className="text-button tiny" disabled={busy} onClick={onChoose}>
              Choose courses
            </button>
          )}
          <button
            className={connected ? "text-button tiny" : "button primary small"}
            disabled={busy}
            onClick={onConnect}
          >
            {connected ? "Reconnect" : "Connect Classroom"}
          </button>
        </div>
      </div>
    </div>
  );
}
