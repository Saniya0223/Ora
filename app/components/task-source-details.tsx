import type { TaskDetail } from "../lib/types";
import { deadline } from "../lib/presentation";
import { safeSourceLink } from "../lib/source-presentation";

const labels: Record<string, string> = {
  currentDeadline: "Deadline changed", venue: "Venue changed", status: "Status changed",
  title: "Title changed", requirements: "Requirements changed", instructions: "Instructions changed",
  topics: "Topics changed", links: "Resource links changed", submissionMethod: "Submission method changed", certainty: "Certainty changed",
};

export function TaskSourceDetails({ task, timezone }: { task: TaskDetail; timezone: string }) {
  const details = task.details;
  const sourceUrl = task.source === "CLASSROOM" ? safeSourceLink(task.sourceUrl, true) : null;
  return <div className="source-task-details">
    {sourceUrl && <a className="text-button" href={sourceUrl} target="_blank" rel="noopener noreferrer">Open in Classroom ↗</a>}
    {!!task.latestChange?.fields.length && <section className="notice" aria-label="What changed">
      <strong>{task.source === "CLASSROOM" ? "Updated from Google Classroom" : "Source updated"}</strong>
      <small>{deadline(task.latestChange.at, timezone)}</small>
      {task.latestChange.fields.map((change) => <div key={change.field}>
        <strong>{labels[change.field] ?? "Details changed"}</strong>
        <p>{change.field === "currentDeadline" ? deadline(change.before, timezone) : change.before ?? "Not set"}
          {" → "}{change.field === "currentDeadline" ? deadline(change.after, timezone) : change.after ?? "Not set"}</p>
      </div>)}
    </section>}
    {details && <section aria-label="Source instructions">
      {details.actionSummary && <p><strong>What to do</strong><br />{details.actionSummary}</p>}
      {details.certainty === "tentative" && <p className="accent-text">Tentative — not a confirmed deadline{details.tentativeDeadline ? `: ${deadline(details.tentativeDeadline, timezone)}` : ""}.</p>}
      {([['Instructions', details.instructions], ['Requirements', details.requirements], ['Topics', details.topics]] as const).map(([label, items]) =>
        items.length > 0 && <div key={label}><strong>{label}</strong><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>)}
      {details.venue && <p><strong>Venue:</strong> {details.venue}</p>}
      {details.submissionMethod && <p><strong>Submission:</strong> {details.submissionMethod}</p>}
      {details.links.some((link) => safeSourceLink(link.url)) && <div><strong>Resources</strong><ul>{details.links.map((link) => {
        const url = safeSourceLink(link.url);
        return url && <li key={url}><a className="text-button" href={url} target="_blank" rel="noopener noreferrer">{link.label ?? new URL(url).hostname} ↗</a></li>;
      })}</ul></div>}
    </section>}
  </div>;
}
