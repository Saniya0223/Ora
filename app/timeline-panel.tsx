"use client";

import { useEffect, useState } from "react";

type Block = { eventId: string; task: string; allocatedHours: number; priority: "High" | "Medium" | "Low" };
type Timeline = {
  days: { date: string; blocks: Block[] }[];
  timetable: { date: string; classes: { startTime: string; endTime: string; subject: string; room: string; type: string }[] }[];
  events: { eventId: string; title: string }[];
  collisionDetected: boolean;
  collisionMessage: string;
  unallocated: { eventId: string; remainingHours: number; reason: string }[];
};
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");

export default function TimelinePanel({ revision }: { revision: number }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!apiBase) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setLoading(true);
    setError("");
    fetch(`${apiBase}/timeline`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Your plan could not be loaded.");
      if (!Array.isArray(body.days) || !Array.isArray(body.timetable)) throw new Error("Your plan could not be read.");
      setTimeline(body);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Your plan could not be loaded.");
      else setError("Your plan took too long to load. Refresh to try again.");
    }).finally(() => { clearTimeout(timeout); setLoading(false); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [revision]);
  const day = timeline?.days[selected];
  return (
    <section id="today" aria-labelledby="plan-heading" className="mt-10 border-y border-rule py-7" aria-busy={loading}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="plan-heading" className="font-display text-3xl">What should I do today?</h2>
        {loading && <span role="status" className="text-sm text-muted">Updating your plan…</span>}
      </div>
      {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
      {!timeline && !loading && <p className="mt-4 text-sm text-muted">Your daily plan will appear once your schedule is connected.</p>}
      {timeline && <>
        {timeline.collisionDetected && <p role="status" className="mt-5 border-l-2 border-accent pl-4 text-sm leading-7"><strong>Workload collision. </strong>{timeline.collisionMessage}</p>}
        <div className="mt-6 flex gap-2 overflow-x-auto pb-2" aria-label="Plan day">
          {timeline.days.map((item, index) => <button key={item.date} type="button" aria-pressed={index === selected} onClick={() => setSelected(index)} className={`shrink-0 rounded-sm border px-4 py-2 text-sm ${index === selected ? "border-accent bg-accent text-white" : "border-rule"}`}>{index === 0 ? "Today" : new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${item.date}T00:00:00Z`))}</button>)}
        </div>
        <div className="mt-4 grid gap-8 lg:grid-cols-[2fr_1fr]">
          <div>
            {!day?.blocks.length && <p className="py-4 text-sm text-muted">No study blocks planned for this day.</p>}
            <ol className="divide-y divide-rule">
              {day?.blocks.map((block) => <li key={block.eventId} className="flex gap-4 py-4"><span className="w-16 shrink-0 pt-1 text-xs font-bold text-accent">{block.priority}</span><div><p className="text-sm font-bold leading-6">{block.task}</p><p className="mt-1 text-xs text-muted">{Number(block.allocatedHours.toFixed(2))} hours allocated</p></div></li>)}
            </ol>
          </div>
          <div><h3 className="text-sm font-bold">Classes</h3><ul className="mt-3 space-y-3">{timeline.timetable[selected]?.classes.map((slot, index) => <li key={`${slot.startTime}-${index}`} className="text-sm leading-6"><span className="text-muted">{slot.startTime}–{slot.endTime}</span><br />{slot.subject}{slot.room ? ` · ${slot.room}` : ""}</li>)}</ul>{!timeline.timetable[selected]?.classes.length && <p className="mt-3 text-sm text-muted">No classes in your saved timetable.</p>}</div>
        </div>
        {timeline.unallocated.length > 0 && <div className="mt-5 border-t border-rule pt-4"><h3 className="text-sm font-bold">Needs attention</h3><ul className="mt-2 space-y-2">{timeline.unallocated.map((item) => <li key={item.eventId} className="text-sm leading-6">{timeline.events.find((event) => event.eventId === item.eventId)?.title}: {Number(item.remainingHours.toFixed(2))} hours still unallocated. {item.reason}.</li>)}</ul></div>}
      </>}
    </section>
  );
}
