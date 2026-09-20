import type { ReactNode } from "react";
import type { ReviewAction, SourceReview } from "../lib/types";
import { actionLabel, candidateMeta, canConfirm, requiresTarget, sourceLabel } from "../lib/review-presentation";
import { safeSourceLink } from "../lib/source-presentation";

type Props = {
  review: SourceReview;
  action: ReviewAction;
  targetEventId: string;
  busy: boolean;
  formatDate: (iso: string) => string;
  onAction: (action: ReviewAction) => void;
  onTarget: (eventId: string) => void;
  onConfirm: () => void;
  footer?: ReactNode; // e.g. an error message
};

// One review: what the source says, what is uncertain, the possible matches, and the choices.
// Matches are always visible, whichever decision is selected.
export function ReviewCardView({ review, action, targetEventId, busy, formatDate, onAction, onTarget, onConfirm, footer }: Props) {
  const original = safeSourceLink(review.sourceUrl, true);
  const needsTarget = requiresTarget(action);
  const choosable = review.candidates.length > 1;
  return <article className="source-review-card">
    <div className="source-review-heading">
      <div>
        <span className="source-review-label">Needs your confirmation · {sourceLabel(review.sourceType)}</span>
        <h3>{review.detectedTitle}</h3>
      </div>
      {original && <a href={original} target="_blank" rel="noopener noreferrer">Open in Classroom ↗</a>}
    </div>
    <p className="source-review-lead">{review.ambiguity}</p>
    {review.reasons.length > 0 && <div className="source-review-block">
      <span className="source-review-subtitle">What Ora noticed</span>
      <ul>{review.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    </div>}
    {review.candidates.length > 0 && <div className="source-review-block" aria-label="Possible matches">
      <span className="source-review-subtitle">{review.candidates.length === 1 ? "Possible match" : "Possible matches"}</span>
      {review.candidates.map((candidate) => {
        const selected = candidate.eventId === targetEventId;
        return <label key={candidate.eventId} className={`source-review-match${selected && needsTarget ? " chosen" : ""}`}>
          {choosable && <input type="radio" name={`match-${review.id}`} checked={selected} disabled={busy} onChange={() => onTarget(candidate.eventId)} />}
          <span>
            <strong>{candidate.title}</strong>
            <small>{candidateMeta(candidate, formatDate)}</small>
            {!!candidate.why?.length && <span className="source-review-why">
              <em>Why it may be related</em>
              {candidate.why.map((why) => <b key={why}>{why}</b>)}
            </span>}
          </span>
        </label>;
      })}
    </div>}
    <details><summary>Read source text{review.sourceFileName ? ` · ${review.sourceFileName}` : ""}</summary><p>{review.sourceExcerpt}</p></details>
    <div className="source-review-controls">
      <label>What should Ora do?
        <select value={action} onChange={(event) => onAction(event.target.value as ReviewAction)} disabled={busy}>
          {review.options.map((option) => <option value={option} key={option}>{actionLabel(review, option)}{option === review.recommendedAction ? " · Recommended" : ""}</option>)}
        </select>
        <span>Ora recommends: {actionLabel(review, review.recommendedAction).toLowerCase()}</span>
      </label>
      <button className="button primary" onClick={onConfirm} disabled={!canConfirm(action, targetEventId, busy)}>{busy ? "Applying…" : "Confirm decision"}</button>
    </div>
    {footer}
  </article>;
}
