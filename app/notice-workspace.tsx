"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AcademicEvent = {
  userId: string;
  eventId: string;
  title: string;
  type: "Exam" | "Assignment" | "Admin" | "Lecture" | "Club" | "Lab";
  currentDeadline: string;
  venue: string | null;
  estimatedHours: number;
  status: "ACTIVE" | "CANCELLED" | "DONE";
  sourceType: "manual" | "pdf" | "classroom";
  sourceRef: string | null;
  priorityScore: number;
  changeHistory: string[];
};

type IngestionResult = {
  action: "CREATE" | "UPDATE" | "CANCEL" | "IGNORE" | "REVIEW";
  event: AcademicEvent | null;
  changeSummary: string;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
const deadline = (value: string) => {
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}+05:30` : value;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(date));
};

async function readResponse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? "The notice service could not be reached. Please try again.");
  }
  if (!body) throw new Error("The service returned an unreadable response. Refresh your events before retrying.");
  return body;
}

export default function NoticeWorkspace({ revision, onChange }: { revision: number; onChange: () => void }) {
  const [text, setText] = useState("");
  const [events, setEvents] = useState<AcademicEvent[]>([]);
  const [result, setResult] = useState<IngestionResult | null>(null);
  const [loading, setLoading] = useState(Boolean(apiBase));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const submitLock = useRef(false);

  const loadEvents = useCallback(async (signal?: AbortSignal) => {
    if (!apiBase) return;
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`${apiBase}/events`, { cache: "no-store", signal });
      const body = await readResponse(response);
      if (!Array.isArray(body.events)) throw new Error("Your event list could not be loaded. Please retry.");
      setEvents(body.events);
      setHasLoaded(true);
    } catch (cause) {
      if (!signal?.aborted) setLoadError(cause instanceof Error ? cause.message : "Your events could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadEvents(controller.signal);
    return () => controller.abort();
  }, [loadEvents, revision]);

  async function submitNotice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiBase || !text.trim() || loading || submitLock.current) return;
    submitLock.current = true;
    setSaving(true);
    setError("");
    setResult(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${apiBase}/ingest`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.trim() }), signal: controller.signal,
      });
      const next: IngestionResult = await readResponse(response);
      if (!["CREATE", "UPDATE", "CANCEL", "IGNORE", "REVIEW"].includes(next.action)
        || typeof next.changeSummary !== "string"
        || (!["IGNORE", "REVIEW"].includes(next.action) && !next.event)) {
        throw new Error("The result could not be confirmed. Refresh your events before retrying.");
      }
      setResult(next);
      if (next.event) {
        const changed = next.event;
        setEvents((current) => {
          const remaining = current.filter((item) => item.eventId !== changed.eventId);
          return changed.status === "ACTIVE" ? [...remaining, changed] : remaining;
        });
      }
      // Keep ignored text available for clarification; preserve all text on failure.
      if (next.action !== "IGNORE" && next.action !== "REVIEW") setText("");
      if (next.action !== "IGNORE") onChange();
    } catch (cause) {
      setError(controller.signal.aborted
        ? "The result could not be confirmed in time. Refresh your events before retrying."
        : cause instanceof Error ? cause.message : "The notice could not be saved. Your text has been kept.");
    } finally {
      clearTimeout(timeout);
      submitLock.current = false;
      setSaving(false);
    }
  }

  const sortedEvents = [...events].sort((left, right) => left.currentDeadline.localeCompare(right.currentDeadline));
  const actionLabel = result && ({ CREATE: "Event added", UPDATE: "CampusFlow detected a change", CANCEL: "Event cancelled", IGNORE: "No change made", REVIEW: "Needs your review" })[result.action];

  return (
    <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <section aria-labelledby="notice-heading">
        <h2 id="notice-heading" className="border-b-2 border-ink pb-4 text-xl font-bold">Add a notice</h2>
        <form className="mt-5" onSubmit={submitNotice}>
          <label htmlFor="notice" className="block text-sm font-bold">What did you receive?</label>
          <p id="notice-help" className="mt-2 text-sm leading-6 text-muted">
            Paste one notice at a time. Include the subject and a clear date, time, and year.
          </p>
          <textarea
            id="notice" name="notice" required maxLength={12_000} rows={8}
            aria-describedby="notice-help notice-count"
            className="mt-4 w-full resize-y rounded-sm border border-rule bg-white p-4 text-sm leading-7 disabled:opacity-60"
            placeholder="DSA assignment is due on 25 September 2026 at 5 pm. Estimated work: 3 hours."
            value={text} onChange={(event) => setText(event.target.value)} disabled={saving}
          />
          <div className="mt-3 flex items-center justify-between gap-4">
            <span id="notice-count" className="text-xs text-muted">{text.length.toLocaleString("en-IN")} / 12,000</span>
            <button type="submit" disabled={!apiBase || !text.trim() || saving || loading}
              className="rounded-sm bg-accent px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Checking notice…" : "Process notice"}
            </button>
          </div>
        </form>
        {!apiBase && <p className="mt-5 text-sm leading-6 text-muted" role="status">The notice service is not connected yet. Your text can be prepared here while the connection is set up.</p>}
        {error && <p className="mt-5 border-l-2 border-ink pl-4 text-sm leading-6" role="alert">{error}</p>}
        {result && (
          <div className="notice-feedback mt-7 border-l-2 border-accent pl-4" role="status" aria-live="polite">
            <h3 className="font-bold">{actionLabel}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{result.changeSummary}</p>
            {result.event && <p className="mt-2 text-sm">{result.event.title}{result.event.status === "CANCELLED" ? " · Cancelled" : ` · ${deadline(result.event.currentDeadline)} IST`}</p>}
          </div>
        )}
      </section>

      <section aria-labelledby="events-heading" aria-busy={loading}>
        <div className="flex items-baseline justify-between gap-3 border-b-2 border-ink pb-4">
          <h2 id="events-heading" className="text-xl font-bold">Current events</h2>
          {apiBase && <button type="button" className="text-sm font-bold text-accent disabled:opacity-50" onClick={() => void loadEvents()} disabled={loading || saving}>{loading ? "Loading…" : "Refresh"}</button>}
        </div>
        <p className="mt-3 text-xs leading-6 text-muted">Ordered by deadline · All times in IST</p>
        {loadError && <p role="alert" className="mt-4 text-sm leading-6">{loadError}</p>}
        {!loading && !sortedEvents.length && (
          <div className="border-b border-rule py-12">
            <h3 className="font-display text-3xl">Room for what matters.</h3>
            <p className="mt-4 text-sm leading-7 text-muted">{hasLoaded ? "No active events yet. Add a notice to start your current plan." : "Your saved events will appear here once the notice service is connected."}</p>
          </div>
        )}
        <ul className="divide-y divide-rule">
          {sortedEvents.map((event) => (
            <li key={event.eventId} className="py-6">
              <p className="text-xs font-bold tracking-wide text-accent uppercase">{event.type}</p>
              <h3 className="mt-2 text-lg font-bold">{event.title}</h3>
              <p className="mt-2 text-sm leading-6">Due {deadline(event.currentDeadline)} IST</p>
              <p className="mt-1 text-sm text-muted">{event.estimatedHours} hours estimated{event.venue ? ` · ${event.venue}` : ""}</p>
              <details className="mt-3 text-sm text-muted">
                <summary className="w-fit cursor-pointer">Change history</summary>
                <ol className="mt-3 space-y-2 border-l border-rule pl-4">
                  {event.changeHistory.map((change, index) => <li key={`${index}-${change}`} className="break-words leading-6">{change}</li>)}
                </ol>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
