"use client";
import { useState } from "react";
import { NoticeInput } from "../components/notice-input";
import { PlanningSettings, ProfileForm } from "../components/planning-settings";
import { ConnectedSources } from "../components/connected-sources";
import {
  TimetableEditor,
  type TimetableDraft,
} from "../components/timetable-editor";
import { Icon } from "../components/ui";
export default function SetupPage() {
  const [manage, setManage] = useState(false);
  const [draft, setDraft] = useState<TimetableDraft | null>(null);
  const openTimetable = () => {
    setManage(true);
    setTimeout(
      () =>
        document
          .getElementById("timetable")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  };
  return (
    <>
      <div className="page-heading">
        <h1>Add & Setup</h1>
        <p>Bring your academic information into CampusFlow.</p>
      </div>
      <div className="setup-grid">
        <div className="column">
          <NoticeInput
            onTimetable={(slots, source, warnings) => {
              setDraft({ slots, source, warnings });
              openTimetable();
            }}
          />
          <PlanningSettings />
        </div>
        <div className="column">
          <ConnectedSources onTimetable={openTimetable} />
          <details className="how-card">
            <summary>
              <Icon name="bulb" size={25} />
              <span>
                <strong>How does this work?</strong>
                <small>
                  CampusFlow turns academic information into tasks, classes and
                  study blocks.
                </small>
              </span>
              <Icon name="chevron" size={15} />
            </summary>
            <p>
              Connect Classroom or paste a notice. Review extracted tasks and
              add effort estimates where needed. Your plan uses available hours
              and deadlines, and shows work that cannot fit. Focus sessions
              record your actual study time.
            </p>
          </details>
        </div>
      </div>
      {manage && (
        <TimetableEditor draft={draft} onSaved={() => setDraft(null)} />
      )}
      <ProfileForm />
    </>
  );
}
