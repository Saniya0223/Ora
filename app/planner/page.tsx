"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { Planner } from "../lib/types";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import {
  addDays,
  clock,
  clock12h,
  timeRange,
  dateKey,
  daySegments,
  placeOverlaps,
  type CalendarItem,
} from "../lib/presentation";
import {
  CapacityWarning,
  Empty,
  ErrorBox,
  Skeleton,
} from "../components/ui";
import { useStudent } from "../components/shell";
import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";

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
  // A rolling week from the chosen day, so upcoming deadlines are in view
  // even late in the calendar week.
  const from = day;
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
  const rowHeight = 88;
  const height = (lastHour - firstHour) * rowHeight;
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
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="page-heading between" style={{ marginBottom: '32px' }}>
        <div>
          <h1>{mode === "week" ? "Weekly" : "Daily"} Planner</h1>
          <p>Visualize your classes, study blocks and important deadlines.</p>
        </div>
      </div>
      <div className="planner-toolbar" style={{ background: 'var(--surface)', padding: '16px', borderRadius: '16px', border: '1px solid var(--line)', marginBottom: '24px' }}>
        <div className="button-row">
          <div className="week-nav" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              className="icon-button"
              aria-label={`Previous ${mode}`}
              onClick={() => navigate(addDays(day, mode === "week" ? -7 : -1))}
              style={{ background: '#f5efe5' }}
            >
              <ChevronLeft size={20} />
            </button>
            <strong style={{ fontSize: '19px' }}>
              {dateLabel(from, { day: "numeric", month: "short" })}
              {mode === "week"
                ? ` – ${dateLabel(to, { day: "numeric", month: "short", year: "numeric" })}`
                : ` ${from.slice(0, 4)}`}
            </strong>
            <button
              className="icon-button"
              aria-label={`Next ${mode}`}
              onClick={() => navigate(addDays(day, mode === "week" ? 7 : 1))}
              style={{ background: '#f5efe5' }}
            >
              <ChevronRight size={20} />
            </button>
          </div>
          <button
            className="button secondary small"
            onClick={() => navigate(today)}
            style={{ borderRadius: '10px' }}
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
              style={mode === "week" ? { background: 'var(--olive)', color: 'white', borderRadius: '10px' } : { background: 'transparent', borderRadius: '10px', color: 'var(--muted)' }}
            >
              Week
            </button>
            <button
              className={mode === "day" ? "selected" : ""}
              aria-pressed={mode === "day"}
              onClick={() => navigate(day, "day")}
              style={mode === "day" ? { background: 'var(--olive)', color: 'white', borderRadius: '10px' } : { background: 'transparent', borderRadius: '10px', color: 'var(--muted)' }}
            >
              Day
            </button>
          </div>
        </div>
      </div>
      <ErrorBox message={error || resource.error} retry={resource.refresh} />
      {resource.loading && !data ? (
        <Skeleton rows={7} />
      ) : (
        data && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '20px', overflow: 'hidden' }}>
            <CapacityWarning capacity={data.capacity} />
            <div className={`calendar-scroll ${mode}`} style={{ padding: '0' }}>
                <div
                  className="calendar"
                  style={{
                    gridTemplateColumns: `75px repeat(${dates.length}, minmax(0, 1fr))`,
                    background: '#fff'
                  }}
                >
                  <div className="calendar-corner" style={{ borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
                  <span className="muted" style={{ display: 'block', padding: '16px 6px', textAlign: 'center', fontSize: '12px' }}>
                    {zone.split("/").pop()?.replaceAll("_", " ")}
                  </span>
                </div>
                {dates.map((d) => (
                  <button
                    key={d}
                    className={`calendar-heading ${d === today ? "is-today" : ""}`}
                    onClick={() => navigate(d, "day")}
                    style={{ 
                      padding: '16px 12px', 
                      borderBottom: '1px solid var(--line)',
                      background: d === today ? 'transparent' : 'transparent',
                      borderLeft: '1px solid var(--line)'
                    }}
                  >
                    <strong style={{ fontSize: '15px', fontWeight: 700, color: d === today ? 'var(--olive)' : 'var(--ink)' }}>{dateLabel(d, { weekday: "short" })}</strong>
                    <span style={{ fontSize: '14px', display: 'block', marginTop: '3px', color: 'var(--muted)', fontWeight: 400 }}>
                      {dateLabel(d, { month: "short", day: "numeric" })}
                    </span>
                  </button>
                ))}
                <div className="deadline-label" style={{ borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '12px 8px', fontSize: '13px' }}>Due</div>
                {dates.map((d) => (
                  <div
                    key={d}
                    className={`deadline-cell ${d === today ? "is-today" : ""}`}
                    style={{ borderLeft: '1px solid var(--line)', borderBottom: '1px solid var(--line)', background: d === today ? 'transparent' : 'transparent', padding: '8px' }}
                  >
                    {data.deadlines
                      .filter((t) => dateKey(t.deadline, zone) === d)
                      .map((t) => (
                        <Link
                          className={`deadline-chip ${t.status === "COMPLETED" ? "completed" : ""}`}
                          key={t.taskId}
                          href={`/tasks?task=${t.taskId}`}
                          title={`${t.title} · ${clock(t.deadline, zone)}`}
                          style={{ borderRadius: '6px', padding: '8px 10px', display: 'block', marginBottom: '4px', background: t.status === "COMPLETED" ? '#f0ece4' : '#fff0db', color: t.status === "COMPLETED" ? 'var(--muted)' : '#a85f09' }}
                        >
                          <strong style={{ display: 'block', fontWeight: 700, whiteSpace: 'normal', wordBreak: 'break-word', fontSize: '14px', lineHeight: '1.3' }}>{t.title}</strong>
                          <span style={{ fontSize: '13px', fontWeight: 500, opacity: 0.7, display: 'flex', alignItems: 'center', gap: '3px', marginTop: '1px' }}>
                            {clock12h(t.deadline, zone)}
                          </span>
                        </Link>
                      ))}
                  </div>
                ))}
                <div className="time-axis" style={{ height, borderRight: '1px solid var(--line)' }}>
                  {Array.from({ length: lastHour - firstHour }, (_, i) => (
                    <span key={i} style={{ top: i * rowHeight, paddingRight: '10px', color: 'var(--muted)', fontSize: '13px', fontWeight: 500 }}>
                      {String(firstHour + i).padStart(2, "0")}:00
                    </span>
                  ))}
                </div>
                {dates.map((d, index) => (
                  <div
                    className={`calendar-day ${d === today ? "is-today" : ""}`}
                    key={d}
                    style={{ height, backgroundSize: `100% ${rowHeight}px`, borderLeft: '1px solid var(--line)', background: 'transparent', backgroundImage: `linear-gradient(var(--line) 1px, transparent 1px)` }}
                  >
                    {segments[index].map((item) => {
                      const height = Math.max(30, ((item.endMinute - item.startMinute) / 60) * rowHeight - 3);
                      // What a block shows depends on the room it has: title first,
                      // then time, then room. Full detail stays in the tooltip and panel.
                      const size = height < 40 ? "xs" : height < 60 ? "sm" : height < 90 ? "md" : "lg";
                      return (
                        <button
                          className={`calendar-block block-${item.type.toLowerCase()}`}
                          data-size={size}
                          data-narrow={item.columns > 1 ? "true" : undefined}
                          key={item.id}
                          style={{
                            top: ((item.startMinute - firstHour * 60) / 60) * rowHeight,
                            height,
                            left: `calc(${(item.column / item.columns) * 100}% + 4px)`,
                            width: `calc(${100 / item.columns}% - 8px)`,
                          }}
                          onClick={() => setSelected(item)}
                          title={`${item.title}, ${timeRange(item.start, item.end, zone)}${item.location ? `, ${item.location}` : ""}${item.outsidePreferredWindow ? " (outside preferred hours)" : ""}`}
                        >
                          <strong>{item.title}</strong>
                          <span className="block-time">{timeRange(item.start, item.end, zone)}</span>
                          {item.location && <span className="block-room">{item.location}</span>}
                          {item.outsidePreferredWindow && <span className="block-warning">Outside preferred hours</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div className="calendar-footer" style={{ padding: '20px', borderTop: '1px solid var(--line)' }}>
              <div className="legend">
                {[
                  ["class", "Lecture"],
                  ["lab", "Lab"],
                  ["study", "Study"],
                  ["event", "Club / Event"],
                  ["deadline", "Task / Deadline"],
                ].map(([key, label]) => (
                  <span key={key} style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <i className={`legend-${key}`} style={{ width: '14px', height: '14px', borderRadius: '4px' }} />
                    {label}
                  </span>
                ))}
              </div>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void replan()}
                style={{ padding: '8px 12px', background: '#f5efe5', borderRadius: '8px' }}
              >
                <RefreshCw size={14} />
                Refresh plan
              </button>
            </div>
            {!items.length && !data.deadlines.length && (
              <div style={{ padding: '40px' }}>
                <Empty title="Nothing to schedule yet.">
                  Study blocks appear once tasks have deadlines. Add your
                  timetable in Setup so they fit around your classes.
                </Empty>
              </div>
            )}
            {selected && (
              <div className="message block-info" style={{ margin: '20px', borderRadius: '12px' }}>
                <button
                  className="icon-button"
                  aria-label="Close schedule details"
                  onClick={() => setSelected(null)}
                >
                  <X size={16} />
                </button>
                <strong style={{ fontSize: '19px', display: 'block', marginBottom: '4px' }}>{selected.title}</strong>
                <p style={{ margin: '0 0 8px' }}>
                  {clock12h(selected.start, zone)} - {clock12h(selected.end, zone)}{" "}
                  {selected.location && `· ${selected.location}`}
                </p>
                {selected.outsidePreferredWindow && (
                  <p style={{ color: '#c45846' }}>Scheduled outside preferred hours to fit the deadline.</p>
                )}
                {selected.taskId && (
                  <Link
                    className="text-link"
                    href={`/tasks?task=${selected.taskId}`}
                    style={{ marginTop: '8px', display: 'inline-block' }}
                  >
                    Open Task →
                  </Link>
                )}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
