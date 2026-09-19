"use client";
import { useState } from "react";
import type { Sources, ClassroomSyncStatus } from "../lib/types";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import { deadline, syncLabel } from "../lib/presentation";
import { safeSourceLink, syncExplanation } from "../lib/source-presentation";
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
  async function sync() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await request<{ sync: ClassroomSyncStatus }>(
        "/classroom/sync",
        "POST",
      );
      const s = r.sync.lastResult;
      setMessage(
        `${syncExplanation(s)}${s ? ` ${s.created} created, ${s.updated} updated, ${s.cancelled} cancelled, ${s.ignored} ignored.` : ""}`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      invalidate();
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
      <p className="muted">Manage your integrations.</p>
      <ErrorBox message={error || resource.error} retry={resource.refresh} />
      {resource.loading && !source && <Skeleton rows={2} />}{" "}
      {source && (
        <div className="source-card">
          <span className="source-icon green">
            <Icon name="cap" size={25} />
          </span>
          <div className="source-copy">
            <strong>Google Classroom</strong>
            <p>
              {source.account?.email ??
                (source.connection === "CONNECTED"
                  ? "Google Classroom connected"
                  : "Connect to capture coursework.")}
            </p>
            <span className="source-status">
              <span className="status-dot" />
              {syncLabel(source.health, source.sync.status)}
            </span>
            <small>{source.selectedCourses.length} selected course(s)</small>
            <small>
              {source.sync.lastSuccessfulSyncAt
                ? `Last successful sync ${deadline(source.sync.lastSuccessfulSyncAt, timezone)}`
                : "No successful sync yet"}
            </small>
            {source.sync.status === "PARTIAL" && (
              <small className="accent-text">
                {syncExplanation(source.sync.lastResult)}
              </small>
            )}
            {source.sync.lastResult?.reviewItems?.map((item) => {
              const url = safeSourceLink(item.sourceUrl, true);
              return <small key={item.sourceRef}>{source.selectedCourses.find((course) => course.id === item.courseId)?.name ?? "Classroom item"}: {item.code.replaceAll("_", " ").toLowerCase()}{url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Review original ↗</a></>}</small>;
            })}
            {source.sync.lastErrorCode && (
              <small className="accent-text">
                {source.sync.lastErrorCode.replaceAll("_", " ").toLowerCase()}
              </small>
            )}
            <div className="button-row source-actions">
              {source.connection === "CONNECTED" && (
                <button
                  className="text-button tiny"
                  disabled={busy}
                  onClick={() => void choose()}
                >
                  Choose courses
                </button>
              )}
              <button
                className="text-button tiny"
                disabled={busy}
                onClick={() => void connect()}
              >
                {source.connection === "CONNECTED"
                  ? "Reconnect"
                  : "Connect Classroom"}
              </button>
            </div>
          </div>
          {source.connection === "CONNECTED" &&
            source.health !== "REAUTH_REQUIRED" && (
              <button
                className="button secondary small"
                disabled={busy || source.sync.status === "SYNCING"}
                onClick={() => void sync()}
              >
                {busy ? "Working…" : "Sync"}
              </button>
            )}
        </div>
      )}
      {timetable && (
        <div className="source-card">
          <span className="source-icon rose">
            <Icon name="calendar" size={25} />
          </span>
          <div className="source-copy">
            <strong>Timetable</strong>
            <p>
              {timetable.source?.fileName ??
                (timetable.status === "READY"
                  ? "Your weekly classes"
                  : "No timetable imported")}
            </p>
            <small>{timetable.slotCount} class slots</small>
            <small>
              {timetable.source
                ? `Updated ${deadline(timetable.source.updatedAt, timezone)}`
                : "Import a PDF or add classes manually."}
            </small>
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
                  "Course selection saved. Use Sync to retrieve new work.",
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
