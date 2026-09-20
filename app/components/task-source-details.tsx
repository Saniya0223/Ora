"use client";

import { useState } from "react";
import type { TaskDetail } from "../lib/types";
import { deadline } from "../lib/presentation";
import { linkLabel, safeSourceLink } from "../lib/source-presentation";
import { errorMessage, request } from "../lib/api";

const labels: Record<string, string> = {
  currentDeadline: "Deadline changed", venue: "Venue changed", status: "Status changed",
  title: "Title changed", requirements: "Requirements changed", instructions: "Instructions changed",
  topics: "Topics changed", links: "Resource links changed", submissionMethod: "Submission method changed", certainty: "Certainty changed",
};

export function TaskSourceDetails({ task, timezone }: { task: TaskDetail; timezone: string }) {
  const [pdfError, setPdfError] = useState("");
  const [openingPdf, setOpeningPdf] = useState(false);
  const details = task.details;
  const sourceUrl = task.source === "CLASSROOM" ? safeSourceLink(task.sourceUrl, true) : null;
  const show = (field: string, value: string | null) =>
    field === "currentDeadline" ? deadline(value, timezone) : value ?? "Not set";
  const changes = task.latestChange?.fields ?? [];
  const deadlineChange = changes.find((change) => change.field === "currentDeadline");
  const changeSummary = [...new Set(changes.map((change) => labels[change.field] ?? "Details changed"))].slice(0, 2).join(" · ");
  async function openPdf(documentId: string) {
    setOpeningPdf(true);
    setPdfError("");
    try {
      const result = await request<{ url: string }>(`/documents/${encodeURIComponent(documentId)}/download`);
      const url = safeSourceLink(result.url);
      if (!url) throw new Error("The PDF download link is unavailable.");
      window.location.assign(url);
    } catch (error) {
      setPdfError(errorMessage(error));
      setOpeningPdf(false);
    }
  }
  return <div className="source-task-details">
    {!!changes.length && <details className="change-callout" aria-label="What changed">
      <summary>
        <span className="change-head">
          <strong>{task.source === "CLASSROOM" ? "Updated from Google Classroom" : "Source updated"}</strong>
          <small>{changeSummary} · {deadline(task.latestChange!.at, timezone)}</small>
          {deadlineChange && <span className="change-deadline">{deadlineChange.after ? `New deadline: ${show("currentDeadline", deadlineChange.after)}` : "Deadline removed"}</span>}
        </span>
        <span className="change-toggle" aria-hidden="true" />
      </summary>
      {changes.map((change) => <div key={change.field} className="change-row">
        <span>{labels[change.field] ?? "Details changed"}</span>
        <p><s>{show(change.field, change.before)}</s>{" → "}<strong>{show(change.field, change.after)}</strong></p>
      </div>)}
    </details>}
    {sourceUrl && <a className="button secondary small source-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Open in Classroom ↗</a>}
    {task.source === "PDF" && task.sourceDocumentId && <button type="button" className="button secondary small source-link" disabled={openingPdf} onClick={() => void openPdf(task.sourceDocumentId!)}>{openingPdf ? "Opening PDF…" : `Open ${task.sourceFileName ?? "source PDF"} ↗`}</button>}
    {task.linkedSources?.filter((source) => source.sourceType === "pdf" && source.documentId).map((source) =>
      <button key={source.documentId} type="button" className="button secondary small source-link" disabled={openingPdf} onClick={() => void openPdf(source.documentId!)}>
        {openingPdf ? "Opening PDF…" : `Open ${source.fileName ?? "source PDF"} ↗`}
      </button>)}
    {pdfError && <p role="alert" className="error">{pdfError}</p>}
    {details && <section aria-label="Source instructions">
      {details.actionSummary && <p><strong>What to do</strong><br />{details.actionSummary}</p>}
      {details.certainty === "tentative" && <p className="accent-text">Tentative — not a confirmed deadline{details.tentativeDeadline ? `: ${deadline(details.tentativeDeadline, timezone)}` : ""}.</p>}
      {([['Instructions', details.instructions], ['Requirements', details.requirements], ['Topics', details.topics]] as const).map(([label, items]) =>
        items.length > 0 && <div key={label}><strong>{label}</strong><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>)}
      {details.venue && <p><strong>Venue:</strong> {details.venue}</p>}
      {details.submissionMethod && <p><strong>Submission:</strong> {details.submissionMethod}</p>}
      {details.links.some((link) => safeSourceLink(link.url)) && <div><strong>Resources</strong><ul>{details.links.map((link) => {
        const url = safeSourceLink(link.url);
        return url && <li key={url}><a className="text-button" href={url} target="_blank" rel="noopener noreferrer">{linkLabel(url, link.label)} ↗</a></li>;
      })}</ul></div>}
    </section>}
  </div>;
}
