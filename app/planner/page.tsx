"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { Planner } from "../lib/types";
import { useResource, invalidate } from "../lib/data";
import { downloadCalendar, request, errorMessage } from "../lib/api";
import {
  addDays,
  clock,
  dateKey,
  monday,
  daySegments,
  placeOverlaps,
  type CalendarItem,
} from "../lib/presentation";
import {
  CapacityWarning,
  Empty,
  ErrorBox,
  Icon,
  Skeleton,
} from "../components/ui";
import { useStudent } from "../components/shell";
export default function PlannerPage() {
  return (
    <Suspense fallback={<Skeleton rows={6} />}>
      <PlannerScreen />
    </Suspense>
  );
}
function PlannerScreen() {
  const { timezone } = useStudent();
  const router = useRouter();
  const params = useSearchParams();
  const today = dateKey(new Date(), timezone);
  const rawDay = params.get("day");
  const day =
    rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) && !isNaN(Date.parse(rawDay))
      ? rawDay
      : today;
  const mode = params.get("mode") === "day" ? "day" : "week";
  const from = mode === "day" ? day : monday(day);
  const to = mode === "day" ? day : addDays(from, 6);
  const query = new URLSearchParams({ from, to });
  const resource = useResource<Planner>(`/planner?${query}`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  const navigate = (d: string, m = mode) =>
    router.replace(`/planner?day=${d}&mode=${m}`, { scroll: false });
  const data = resource.data;
  const zone = data?.range.timezone ?? timezone;
  const dates = Array.from({ length: mode === "week" ? 7 : 1 }, (_, i) =>
    addDays(from, i),
  );
  const items: CalendarItem[] = data
    ? [...data.classes.map((c) => ({ ...c, taskId: null })), ...data.blocks]
    : [];
  const segments = dates.map((d) => placeOverlaps(daySegments(items, d, zone)));
  const flat = segments.flat();
  const earliest = flat.length
    ? Math.min(480, ...flat.map((i) => i.startMinute))
    : 480;
  const latest = flat.length
    ? Math.max(1260, ...flat.map((i) => i.endMinute))
    : 1260;
  const firstHour = Math.floor(earliest / 60);
  const lastHour = Math.min(24, Math.ceil(latest / 60));
  const rowHeight = 64;
  const height = (lastHour - firstHour) * rowHeight;
  async function exportIcs() {
    setBusy(true);
    setError("");
    try {
      await downloadCalendar(
        `/planner/export?${query}`,
        `campusflow-${from}-to-${to}.ics`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function replan() {
    setBusy(true);
    setError("");
    try {
      await request("/schedule/replan", "POST");
      invalidate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const dateLabel = (d: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(
      new Date(`${d}T12:00:00Z`),
    );
  return (
    <>
      <div className="page-heading">
        <h1>{mode === "week" ? "Weekly" : "Daily"} Planner</h1>
        <p>Visualize your classes, study blocks and important deadlines.</p>
      </div>
      <div className="planner-toolbar">
        <div className="button-row">
          <div className="week-nav">
            <button
              className="icon-button"
              aria-label={`Previous ${mode}`}
              onClick={() => navigate(addDays(day, mode === "week" ? -7 : -1))}
            >
              ‹
            </button>
            <strong>
              {dateLabel(from, { day: "numeric", month: "short" })}
              {mode === "week"
                ? ` – ${dateLabel(to, { day: "numeric", month: "short", year: "numeric" })}`
                : ` ${from.slice(0, 4)}`}
            </strong>
            <button
              className="icon-button"
              aria-label={`Next ${mode}`}
              onClick={() => navigate(addDays(day, mode === "week" ? 7 : 1))}
            >
              ›
            </button>
          </div>
          <button
            className="button secondary small"
            onClick={() => navigate(today)}
          >
            Today
          </button>
        </div>
        <div className="button-row">
          <div className="pills">
            <button
              className={mode === "week" ? "selected" : ""}
              aria-pressed={mode === "week"}
              onClick={() => navigate(day, "week")}
            >
              Week
            </button>
            <button
              className={mode === "day" ? "selected" : ""}
              aria-pressed={mode === "day"}
              onClick={() => navigate(day, "day")}
            >
              Day
            </button>
          </div>
          <button
            className="button secondary small"
            disabled={busy || !data}
            onClick={() => void exportIcs()}
          >
            <Icon name="download" size={15} />
            Export
          </button>
        </div>
      </div>
      <ErrorBox message={error || resource.error} retry={resource.refresh} />
      {resource.loading && !data ? (
        <Skeleton rows={7} />
      ) : (
        data && (
          <>
            <CapacityWarning capacity={data.capacity} />
            <div className={`calendar-scroll ${mode}`}>
              <div
                className="calendar"
                style={{
                  gridTemplateColumns: `52px repeat(${dates.length}, minmax(0, 1fr))`,
                }}
              >
                <div className="calendar-corner">
                  <span className="tiny muted">
                    {zone.split("/").pop()?.replaceAll("_", " ")}
                  </span>
                </div>
                {dates.map((d) => (
                  <button
                    key={d}
                    className={`calendar-heading ${d === today ? "is-today" : ""}`}
                    onClick={() => navigate(d, "day")}
                  >
                    <strong>{dateLabel(d, { weekday: "short" })}</strong>
                    <span>
                      {dateLabel(d, { month: "short", day: "numeric" })}
                    </span>
                  </button>
                ))}
                <div className="deadline-label tiny">Due</div>
                {dates.map((d) => (
                  <div
                    key={d}
                    className={`deadline-cell ${d === today ? "is-today" : ""}`}
                  >
                    {data.deadlines
                      .filter((t) => dateKey(t.deadline, zone) === d)
                      .map((t) => (
                        <Link
                          className={`deadline-chip ${t.status === "COMPLETED" ? "completed" : ""}`}
                          key={t.taskId}
                          href={`/tasks?task=${t.taskId}`}
                          title={`${t.title} · ${clock(t.deadline, zone)}`}
                        >
                          {t.title} · {clock(t.deadline, zone)}
                        </Link>
                      ))}
                  </div>
                ))}
                <div className="time-axis" style={{ height }}>
                  {Array.from({ length: lastHour - firstHour }, (_, i) => (
                    <span key={i} style={{ top: i * rowHeight }}>
                      {String(firstHour + i).padStart(2, "0")}:00
                    </span>
                  ))}
                </div>
                {dates.map((d, index) => (
                  <div
                    className={`calendar-day ${d === today ? "is-today" : ""}`}
                    key={d}
                    style={{ height, backgroundSize: `100% ${rowHeight}px` }}
                  >
                    {segments[index].map((item) => (
                      <button
                        className={`calendar-block block-${item.type.toLowerCase()}`}
                        key={item.id}
                        style={{
                          top:
                            ((item.startMinute - firstHour * 60) / 60) *
                            rowHeight,
                          height: Math.max(
                            22,
                            ((item.endMinute - item.startMinute) / 60) *
                              rowHeight -
                              3,
                          ),
                          left: `calc(${(item.column / item.columns) * 100}% + 3px)`,
                          width: `calc(${100 / item.columns}% - 6px)`,
                        }}
                        onClick={() => setSelected(item)}
                        title={`${item.title}, ${clock(item.start, zone)}–${clock(item.end, zone)}${item.location ? `, ${item.location}` : ""}`}
                      >
                        <strong>{item.title}</strong>
                        <span>
                          {clock(item.start, zone)} – {clock(item.end, zone)}
                        </span>
                        {mode === "day" && item.location && (
                          <span>{item.location}</span>
                        )}
                        {item.outsidePreferredWindow && (
                          <span>Outside preferred hours</span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="calendar-footer">
              <div className="legend">
                {[
                  ["class", "Lecture"],
                  ["lab", "Lab"],
                  ["study", "Study"],
                  ["event", "Club / Event"],
                  ["deadline", "Task / Deadline"],
                ].map(([key, label]) => (
                  <span key={key}>
                    <i className={`legend-${key}`} />
                    {label}
                  </span>
                ))}
              </div>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void replan()}
              >
                <Icon name="refresh" size={14} />
                Refresh plan
              </button>
            </div>
            {!items.length && !data.deadlines.length && (
              <Empty title="Space for your next step.">
                Import your timetable to see classes, or add effort estimates to
                tasks to generate study blocks.
              </Empty>
            )}
            {selected && (
              <div className="message block-info">
                <button
                  className="icon-button"
                  aria-label="Close schedule details"
                  onClick={() => setSelected(null)}
                >
                  <Icon name="close" size={16} />
                </button>
                <strong>{selected.title}</strong>
                <p>
                  {clock(selected.start, zone)} – {clock(selected.end, zone)}{" "}
                  {selected.location && `· ${selected.location}`}
                </p>
                {selected.outsidePreferredWindow && (
                  <p>Scheduled outside preferred hours to fit the deadline.</p>
                )}
                {selected.taskId && (
                  <Link
                    className="text-link"
                    href={`/tasks?task=${selected.taskId}`}
                  >
                    Open Task →
                  </Link>
                )}
              </div>
            )}
          </>
        )
      )}
    </>
  );
}
