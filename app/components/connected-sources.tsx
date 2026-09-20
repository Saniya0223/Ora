"use client";
import { useState } from "react";
import Image from "next/image";
import type { Sources } from "../lib/types";
import { useClassroomSync } from "./classroom-sync";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import { deadline } from "../lib/presentation";
import { safeSourceLink, syncExplanation, syncSummary } from "../lib/source-presentation";
import { CalendarDays, RefreshCw } from "lucide-react";
import { useStudent } from "./shell";
import { ErrorBox, Modal, Skeleton } from "./ui";
import { ReviewQueue } from "./review-queue";
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
        <div className="source-card timetable-source-card">
          <span className="timetable-source-icon">
            <CalendarDays size={26} aria-hidden="true" />
          </span>
          <div className="timetable-source-copy">
            <strong>Timetable</strong>
            {timetable.status === "READY" ? (
              <p><span className="status-dot on" />{timetable.slotCount} classes a week</p>
            ) : (
              <p>Add your timetable so Ora can plan around your classes.</p>
            )}
          </div>
          <button className="timetable-edit-button" onClick={onTimetable}>
            {timetable.status === "READY" ? "Edit" : "Add"}
          </button>
          {timetable.status === "READY" && <div className="timetable-provenance">
            {timetable.source?.fileName ? <>From <strong>{timetable.source.fileName}</strong> · updated {deadline(timetable.source.updatedAt, timezone)}</> : "Added manually"}
          </div>}
        </div>
      )}
      <ReviewQueue />
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
    <div className="source-card classroom-source connected-classroom">
      <div className="classroom-identity">
        <Image src="/google-classroom.svg" width={52} height={52} alt="Google Classroom logo" className="classroom-brand" />
        <div>
          <h3>Google Classroom</h3>
          <p className="classroom-connection"><span className={`status-dot ${connected ? "on" : ""}`} />
            {connected ? "Connected" : "Not connected"}
            {connected && courseNames && <span className="muted">&middot; {courseNames}</span>}
          </p>
        </div>
      </div>
      {connected && source.health !== "REAUTH_REQUIRED" && <div className="classroom-automation">
        <span>Working in the background</span>
        <strong>Automatically synced every 15 minutes</strong>
        <p>Ora watches for coursework edits and brings changes into your tasks. No manual syncing needed.</p>
      </div>}
      <div className={`sync-summary classroom-status ${summary.tone}`} role="status">
        <strong>{summary.tone === "busy" ? "..." : summary.tone === "ok" ? "\u2713" : summary.tone === "review" ? "\u2022" : "!"} {summary.title}</strong>
        {summary.detail && <small>{summary.detail}</small>}
        {summary.changes.filter((change) => change !== summary.title).length > 0 && <ul>
          {summary.changes.filter((change) => change !== summary.title).map((change) => <li key={change}>{change}</li>)}
        </ul>}
        {summary.tone !== "busy" && result?.reviewItems?.map((item) => {
          const url = safeSourceLink(item.sourceUrl, true);
          const course = source.selectedCourses.find((c) => c.id === item.courseId)?.name ?? "Classroom";
          return <small key={item.sourceRef}>{course} post &middot; <a href="#source-reviews">Decide what to do</a>{url && <> &middot; <a href={url} target="_blank" rel="noopener noreferrer">Open in Classroom</a></>}</small>;
        })}
      </div>
      <div className="classroom-controls">
        {connected && source.health !== "REAUTH_REQUIRED" && <div className="classroom-manual">
          <button className="classroom-sync-button" disabled={busy || syncing} onClick={onSync}>
            <RefreshCw size={17} className={summary.tone === "busy" ? "spin" : ""} aria-hidden="true" />
            {summary.tone === "busy" ? "Syncing..." : "Sync now"}
          </button>
          <span>Optional immediate refresh</span>
        </div>}
        <div className="classroom-links">
          {connected && <button className="text-button tiny" disabled={busy} onClick={onChoose}>Choose courses</button>}
          <button className={connected ? "text-button tiny" : "button primary small"} disabled={busy} onClick={onConnect}>
            {connected ? "Reconnect" : "Connect Classroom"}
          </button>
        </div>
      </div>
      <details className="sync-details classroom-details">
        <summary>Details</summary>
        {result ? <small>
          Checked {result.announcementsScanned} announcements and {result.courseworkScanned} coursework
          items in {result.coursesScanned} course{result.coursesScanned === 1 ? "" : "s"}
          {result.ignored ? ` \u00b7 ${result.ignored} with nothing to do` : ""}.
          {source.sync.lastFinishedAt ? ` Finished ${deadline(source.sync.lastFinishedAt, timezone)}.` : ""}
        </small> : <small>No sync details yet.</small>}
        {result && summary.tone !== "ok" && <small>{syncExplanation(result)}</small>}
      </details>
    </div>
  );
}
