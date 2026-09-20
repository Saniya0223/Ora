"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  FileText,
  Lightbulb,
  SlidersHorizontal,
} from "lucide-react";
import { NoticeInput } from "../components/notice-input";
import { PlanningSettings } from "../components/planning-settings";
import { ConnectedSources } from "../components/connected-sources";
import { useStudent } from "../components/shell";
import { TimetableEditor, type TimetableDraft } from "../components/timetable-editor";
import { useResource } from "../lib/data";
import { deadline } from "../lib/presentation";
import type { TaskList } from "../lib/types";


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
    <div className="setup-page animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="setup-hero">
        <div className="setup-hero-copy">
          <span className="setup-eyebrow">Your academic workspace</span>
          <h1>Add &amp; Setup</h1>
          <p>
            Bring coursework, class time, and new notices into one plan you can
            trust. Start with your sources, then set the time you have to study.
          </p>
          <div className="setup-hero-links">
            <a href="#sources">Manage sources <ArrowUpRight size={15} aria-hidden="true" /></a>
            <Link href="/planner">See your plan <ArrowUpRight size={15} aria-hidden="true" /></Link>
          </div>
        </div>
      </header>

      <div className="setup-workflow">
        <section className="setup-step" aria-labelledby="setup-sources-title">
          <div className="setup-step-intro">
            <span className="setup-step-number">01 / CONNECT</span>
            <span className="setup-step-icon"><CalendarDays size={21} aria-hidden="true" /></span>
            <h2 id="setup-sources-title">Keep your sources current</h2>
            <p>Choose the courses to watch and add fixed classes so new work lands in the right week.</p>
          </div>
          <div className="setup-step-content">
            <ConnectedSources onTimetable={openTimetable} />
          </div>
        </section>

        <section className="setup-step" aria-labelledby="setup-planning-title">
          <div className="setup-step-intro">
            <span className="setup-step-number">02 / PLAN</span>
            <span className="setup-step-icon"><SlidersHorizontal size={21} aria-hidden="true" /></span>
            <h2 id="setup-planning-title">Make the plan yours</h2>
            <p>Set a realistic daily limit and study window. Your timetable remains protected from study blocks.</p>
          </div>
          <div className="setup-step-content">
            <PlanningSettings />
          </div>
        </section>

        <section className="setup-step" aria-labelledby="setup-add-title">
          <div className="setup-step-intro">
            <span className="setup-step-number">03 / ADD</span>
            <span className="setup-step-icon"><FileText size={21} aria-hidden="true" /></span>
            <h2 id="setup-add-title">Bring in something new</h2>
            <p>Paste a notice or upload a PDF for work that is not in Classroom.</p>
          </div>
          <div className="setup-step-content">
            <NoticeInput
              onTimetable={(slots, source, warnings) => {
                setDraft({ slots, source, warnings });
                openTimetable();
              }}
            />
          </div>
        </section>
      </div>

      {manage && <TimetableEditor draft={draft} onSaved={() => setDraft(null)} />}

      <details className="how-card setup-how">
        <summary>
          <Lightbulb size={18} aria-hidden="true" />
          <strong>How does Ora keep tasks current?</strong>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <p>
          Ora turns each Classroom post into one task, updates that task
          when the post changes, and plans study time around your classes. Open
          a task brief to see its deadline and what changed at the source.
        </p>
      </details>
    </div>
  );
}
