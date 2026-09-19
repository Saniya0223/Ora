"use client";
import { useEffect, useState } from "react";
import type { TimetableSlot, TimetableSource } from "../lib/types";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import { ErrorBox, Icon, Skeleton } from "./ui";
export type TimetableDraft = {
  slots: TimetableSlot[];
  source: { fileName: string; jobId: string };
  warnings: string[];
};
type EditableSlot = Omit<TimetableSlot, "id"> & { id?: string };
const days: TimetableSlot["day"][] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export function TimetableEditor({
  draft,
  onSaved,
}: {
  draft: TimetableDraft | null;
  onSaved: () => void;
}) {
  const r = useResource<{
    slots: TimetableSlot[];
    source: TimetableSource | null;
  }>("/timetable");
  const [slots, setSlots] = useState<EditableSlot[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (draft) {
      setSlots(draft.slots);
      setDirty(true);
    } else if (r.data && !dirty) setSlots(r.data.slots);
  }, [draft, r.data, dirty]);
  const change = (index: number, key: keyof EditableSlot, value: string) => {
    setDirty(true);
    setSlots((s) =>
      s.map((slot, i) => (i === index ? { ...slot, [key]: value } : slot)),
    );
  };
  return (
    <section className="card timetable-editor" id="timetable">
      <div className="panel-heading">
        <div>
          <h2>{draft ? "Review imported timetable" : "Manage timetable"}</h2>
          <p className="muted">
            Check each class before saving. Changes update your study plan.
          </p>
        </div>
      </div>
      <ErrorBox message={error || r.error} retry={r.refresh} />
      {draft?.warnings.length ? (
        <div className="message warning">
          <strong>Rows that need attention</strong>
          {draft.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      ) : null}
      {r.loading && !r.data && !draft ? (
        <Skeleton rows={2} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (slots.some((s) => s.startTime >= s.endTime)) {
              setError("Every class must end after it starts.");
              return;
            }
            setBusy(true);
            setError("");
            try {
              const saved = await request<{ slots: TimetableSlot[] }>(
                "/timetable",
                "PUT",
                { slots, ...(draft ? { source: draft.source } : {}) },
              );
              setSlots(saved.slots);
              setDirty(false);
              setMessage("Timetable saved.");
              onSaved();
              invalidate();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {["Day", "Start", "End", "Subject", "Type", "Room", ""].map(
                    (h, i) => (
                      <th key={i}>{h}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {slots.map((s, i) => (
                  <tr key={s.id ?? `new-${i}`}>
                    <td>
                      <select
                        aria-label={`Day for class ${i + 1}`}
                        value={s.day}
                        onChange={(e) => change(i, "day", e.target.value)}
                      >
                        {days.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        required
                        aria-label={`Start for class ${i + 1}`}
                        type="time"
                        value={s.startTime}
                        onChange={(e) => change(i, "startTime", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        required
                        aria-label={`End for class ${i + 1}`}
                        type="time"
                        value={s.endTime}
                        onChange={(e) => change(i, "endTime", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        required
                        aria-label={`Subject for class ${i + 1}`}
                        value={s.subject}
                        onChange={(e) => change(i, "subject", e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`Type for class ${i + 1}`}
                        value={s.type}
                        onChange={(e) => change(i, "type", e.target.value)}
                      >
                        {["Lecture", "Lab", "Tutorial"].map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`Room for class ${i + 1}`}
                        value={s.room}
                        onChange={(e) => change(i, "room", e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove class ${i + 1}`}
                        onClick={() => {
                          setDirty(true);
                          setSlots(slots.filter((_, j) => j !== i));
                        }}
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!slots.length && (
            <p className="muted">
              Import a timetable PDF above or add your first class.
            </p>
          )}
          <div className="button-row between">
            <button
              type="button"
              className="text-button"
              disabled={slots.length >= 150}
              onClick={() => {
                setDirty(true);
                setSlots([
                  ...slots,
                  {
                    day: "Monday",
                    startTime: "09:00",
                    endTime: "10:00",
                    subject: "",
                    type: "Lecture",
                    room: "",
                  },
                ]);
              }}
            >
              <Icon name="plus" size={15} />
              Add class
            </button>
            <div className="button-row">
              <span role="status" className="tiny">
                {dirty ? "Unsaved changes" : message}
              </span>
              <button className="button primary" disabled={busy || !dirty}>
                {busy
                  ? "Saving…"
                  : draft
                    ? "Confirm & save timetable"
                    : "Save timetable"}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
