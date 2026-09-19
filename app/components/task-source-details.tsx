import type { TaskDetail } from "../lib/types";
import { deadline } from "../lib/presentation";
import { linkLabel, safeSourceLink } from "../lib/source-presentation";

const labels: Record<string, string> = {
  currentDeadline: "Deadline changed", venue: "Venue changed", status: "Status changed",
  title: "Title changed", requirements: "Requirements changed", instructions: "Instructions changed",
  topics: "Topics changed", links: "Resource links changed", submissionMethod: "Submission method changed", certainty: "Certainty changed",
};

export function TaskSourceDetails({ task, timezone }: { task: TaskDetail; timezone: string }) {
  const details = task.details;
  const sourceUrl = task.source === "CLASSROOM" ? safeSourceLink(task.sourceUrl, true) : null;
  const show = (field: string, value: string | null) =>
    field === "currentDeadline" ? deadline(value, timezone) : value ?? "Not set";
  return <div className="source-task-details">
    {!!task.latestChange?.fields.length && <section className="change-callout" aria-label="What changed">
      <header>
        <strong>{task.source === "CLASSROOM" ? "Updated from Google Classroom" : "Source updated"}</strong>
        <small>{deadline(task.latestChange.at, timezone)}</small>
      </header>
      {task.latestChange.fields.map((change) => <div key={change.field} className="change-row">
        <span>{labels[change.field] ?? "Details changed"}</span>
        <p><s>{show(change.field, change.before)}</s>{" → "}<strong>{show(change.field, change.after)}</strong></p>
      </div>)}
    </section>}
    {sourceUrl && <a className="button secondary small source-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Open in Classroom ↗</a>}
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
