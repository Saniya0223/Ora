"use client";
import { useState } from "react";
import { NoticeInput } from "../components/notice-input";
import { PlanningSettings } from "../components/planning-settings";
import { ConnectedSources } from "../components/connected-sources";
import {
  TimetableEditor,
  type TimetableDraft,
} from "../components/timetable-editor";
import { ChevronDown, Lightbulb } from "lucide-react";

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
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="page-heading intro" style={{ marginBottom: '32px' }}>
        <div>
          <h1>Add & Setup</h1>
          <p>Connect your sources and tune how CampusFlow plans your week.</p>
        </div>
      </div>
      
      {/* Sources and planning come first; manual entry is a secondary path. */}
      <div className="setup-grid">
        <div className="column">
          <ConnectedSources onTimetable={openTimetable} />
          <PlanningSettings />
        </div>
        <aside className="column setup-aside" aria-label="Other ways to add work">
          <p className="section-label">Other ways to add work</p>
          <NoticeInput
            onTimetable={(slots, source, warnings) => {
              setDraft({ slots, source, warnings });
              openTimetable();
            }}
          />
          <details className="how-card">
            <summary>
              <Lightbulb size={18} />
              <strong>How does this work?</strong>
              <ChevronDown size={16} />
            </summary>
            <p>
              CampusFlow turns each Classroom post into one task, updates that
              task when the post changes, and plans study time around your
              classes.
            </p>
          </details>
        </aside>
      </div>
      {manage && (
        <TimetableEditor draft={draft} onSaved={() => setDraft(null)} />
      )}
    </div>
  );
}
