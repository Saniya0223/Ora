"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { FocusSession } from "../lib/types";
import { request, errorMessage } from "../lib/api";
import { invalidate } from "../lib/data";
import { focusRemaining } from "../lib/presentation";
import { Icon } from "./ui";
const FocusContext = createContext<{
  start: (taskId: string) => Promise<void>;
  busy: boolean;
}>({ start: async () => {}, busy: false });
export const useFocus = () => useContext(FocusContext);
export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<FocusSession | null>(null);
  const [sampledAt, setSampledAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const accept = useCallback((s: FocusSession | null) => {
    setSession(s);
    setSampledAt(Date.now());
    setNow(Date.now());
  }, []);
  const restore = useCallback(async () => {
    try {
      const r = await request<{ session: FocusSession | null }>(
        "/focus-sessions/active",
      );
      accept(r.session);
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }, [accept]);
  useEffect(() => {
    void restore();
    const visible = () => {
      if (document.visibilityState === "visible" && !lock.current)
        void restore();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [restore]);
  useEffect(() => {
    if (!session?.isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.isRunning]);
  const transition = useCallback(
    async (action: string) => {
      if (!session || lock.current) return;
      lock.current = true;
      setBusy(true);
      setMessage("");
      try {
        const r = await request<{
          session: FocusSession;
          creditedMinutes?: number;
        }>(`/focus-sessions/${session.id}/${action}`, "POST");
        accept(
          r.session.status === "ACTIVE" || r.session.status === "PAUSED"
            ? r.session
            : null,
        );
        if (action === "complete")
          setMessage(
            `Focus saved. ${r.creditedMinutes ?? 0} minute(s) added to your task.`,
          );
        invalidate();
      } catch (e) {
        setMessage(errorMessage(e));
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [session, accept],
  );
  const remaining = session ? focusRemaining(session, sampledAt, now) : 0;
  const completedAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (
      session?.isRunning &&
      remaining === 0 &&
      !busy &&
      completedAttempt.current !== session.id
    ) {
      // Attempt once per session. A failed request remains retryable with Finish.
      completedAttempt.current = session.id;
      void transition("complete");
    }
  }, [session, remaining, busy, transition]);
  const start = async (id: string) => {
    if (lock.current) return;
    if (session) {
      setMessage(
        "Finish or cancel your current focus session before starting another.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      accept(
        (
          await request<{ session: FocusSession }>(
            `/tasks/${id}/focus-sessions`,
            "POST",
            { plannedMinutes: 25 },
          )
        ).session,
      );
    } catch (e) {
      setMessage(errorMessage(e));
      await restore();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <FocusContext.Provider value={{ start, busy }}>
      {children}
      {(session || message) && (
        <section className="focus-dock" aria-label="Focus session">
          <div>
            <span className="eyebrow">
              <Icon name="clock" size={15} />{" "}
              {session ? "FOCUS SESSION" : "FOCUS UPDATE"}
            </span>
            {session && (
              <Link
                href={`/tasks?task=${session.taskId}`}
                className="focus-task"
              >
                {session.taskTitle}
              </Link>
            )}
            {message && <p role="status">{message}</p>}
          </div>
          {session && (
            <>
              <strong
                className="timer"
                role="timer"
                aria-label="Time remaining"
              >
                {String(Math.floor(remaining / 60)).padStart(2, "0")}:
                {String(remaining % 60).padStart(2, "0")}
              </strong>
              <div className="button-row">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void transition(session.isRunning ? "pause" : "resume")
                  }
                >
                  {session.isRunning ? "Pause" : "Resume"}
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void transition("complete")}
                >
                  Finish
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void transition("cancel")}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
          {!session && (
            <button
              className="icon-button"
              aria-label="Dismiss focus message"
              onClick={() => setMessage("")}
            >
              <Icon name="close" />
            </button>
          )}
        </section>
      )}
    </FocusContext.Provider>
  );
}
