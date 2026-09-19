"use client";
import { useEffect, useState } from "react";
import type { Preferences, Profile } from "../lib/types";
import { useResource, invalidate } from "../lib/data";
import { request, errorMessage } from "../lib/api";
import { ErrorBox, Skeleton } from "./ui";
export function PlanningSettings() {
  const r = useResource<{ preferences: Preferences }>("/preferences");
  const [value, setValue] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (r.data) setValue(r.data.preferences);
  }, [r.data]);
  return (
    <section className="card">
      <h2>Planning Settings</h2>
      <p className="muted">Customize your study schedule and preferences.</p>
      <ErrorBox message={error || r.error} retry={r.refresh} />
      {r.loading && !value && <Skeleton rows={2} />}{" "}
      {value && (
        <form
          className="form-stack settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (value.preferredStudyStart >= value.preferredStudyEnd) {
              setError(
                "Study hours must start before they end on the same day.",
              );
              return;
            }
            setBusy(true);
            setError("");
            setMessage("");
            try {
              const saved = await request<{ preferences: Preferences }>(
                "/preferences",
                "PUT",
                value,
              );
              setValue(saved.preferences);
              setMessage("Planning settings saved.");
              invalidate();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <label>
              Daily study limit
              <strong className="range-value">
                {value.dailyStudyHours} hours
              </strong>
              <input
                type="range"
                min={1}
                max={12}
                step={0.25}
                value={value.dailyStudyHours}
                onChange={(e) =>
                  setValue({
                    ...value,
                    dailyStudyHours: Number(e.target.value),
                  })
                }
              />
              <span className="range-labels">
                <span>1h</span>
                <span>12h</span>
              </span>
            </label>
            <div>
              <span className="field-label">Preferred study time</span>
              <div className="time-window">
                <label>
                  <span className="sr-only">Study starts</span>
                  <input
                    type="time"
                    required
                    value={value.preferredStudyStart}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        preferredStudyStart: e.target.value,
                      })
                    }
                  />
                </label>
                <span>–</span>
                <label>
                  <span className="sr-only">Study ends</span>
                  <input
                    type="time"
                    required
                    value={value.preferredStudyEnd}
                    onChange={(e) =>
                      setValue({ ...value, preferredStudyEnd: e.target.value })
                    }
                  />
                </label>
              </div>
            </div>
          </div>
          <label>
            Timezone
            <input
              required
              value={value.timezone}
              onChange={(e) => setValue({ ...value, timezone: e.target.value })}
            />
          </label>
          <div className="settings-checks">
            <label className="check-label">
              <input
                type="checkbox"
                checked={value.autoScheduleStudyBlocks}
                onChange={(e) =>
                  setValue({
                    ...value,
                    autoScheduleStudyBlocks: e.target.checked,
                  })
                }
              />
              Auto-schedule study blocks
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={value.avoidClassConflicts}
                onChange={(e) =>
                  setValue({ ...value, avoidClassConflicts: e.target.checked })
                }
              />
              Avoid class time conflicts
            </label>
          </div>
          <div className="button-row between">
            <span className="tiny" role="status">
              {message}
            </span>
            <button className="button primary small" disabled={busy}>
              {busy ? "Saving…" : "Save Settings"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
export function ProfileForm() {
  const r = useResource<{ profile: Profile | null }>("/profile");
  const [form, setForm] = useState({
    name: "",
    program: "",
    year: "",
    section: "",
    semester: "",
    semesterStartDate: "",
    timezone: "Asia/Kolkata",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (r.data?.profile) {
      const p = r.data.profile;
      setForm({
        name: p.name,
        program: p.program,
        year: p.year,
        section: p.section,
        semester: p.semester ?? "",
        semesterStartDate: p.semesterStartDate ?? "",
        timezone: p.timezone,
      });
    }
  }, [r.data]);
  return (
    <section className="card" id="profile">
      <h2>Student profile</h2>
      <p className="muted">
        Your academic details keep your workspace relevant.
      </p>
      <ErrorBox message={error || r.error} retry={r.refresh} />
      {r.loading && !r.data ? (
        <Skeleton rows={2} />
      ) : (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await request("/profile", "PUT", {
                ...form,
                semester: form.semester || null,
                semesterStartDate: form.semesterStartDate || null,
              });
              setMessage("Profile saved.");
              invalidate();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            {(
              [
                "name",
                "program",
                "year",
                "section",
                "semester",
                "semesterStartDate",
                "timezone",
              ] as const
            ).map((key) => (
              <label key={key}>
                {
                  {
                    name: "Name",
                    program: "Program",
                    year: "Year",
                    section: "Section",
                    semester: "Semester (optional)",
                    semesterStartDate: "Semester starts (optional)",
                    timezone: "Timezone",
                  }[key]
                }
                <input
                  required={!["semester", "semesterStartDate"].includes(key)}
                  type={key === "semesterStartDate" ? "date" : "text"}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="button-row between">
            <span role="status" className="tiny">
              {message}
            </span>
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
