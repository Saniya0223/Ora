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
          <p>Bring your academic information into CampusFlow.</p>
        </div>
      </div>
      
      <div className="setup-grid" style={{ display: 'grid', gap: '32px', gridTemplateColumns: '1.2fr 1fr', alignItems: 'start' }}>
        <div className="column" style={{ display: 'grid', gap: '32px' }}>
          <NoticeInput
            onTimetable={(slots, source, warnings) => {
              setDraft({ slots, source, warnings });
              openTimetable();
            }}
          />
          <PlanningSettings />
        </div>
        <div className="column" style={{ display: 'grid', gap: '32px' }}>
          <ConnectedSources onTimetable={openTimetable} />
          <details className="how-card" style={{ background: '#fff9e6', borderRadius: '16px', border: '1px solid #ffe699', padding: '24px' }}>
            <summary style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', listStyle: 'none', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ background: '#ffeb99', color: '#b38000', width: '48px', height: '48px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Lightbulb size={24} />
                </div>
                <div>
                  <strong style={{ fontSize: '16px', color: '#b38000', display: 'block' }}>How does this work?</strong>
                  <small style={{ color: '#b38000', opacity: 0.8, fontSize: '13px' }}>
                    CampusFlow turns academic information into tasks, classes and
                    study blocks.
                  </small>
                </div>
              </div>
              <ChevronDown size={20} color="#b38000" />
            </summary>
            <p style={{ marginTop: '20px', color: '#996600', lineHeight: 1.6, fontSize: '14px' }}>
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
    </div>
  );
}
