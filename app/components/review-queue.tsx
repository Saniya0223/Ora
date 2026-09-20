"use client";

import { useState } from "react";
import type { ReviewAction, SourceReview } from "../lib/types";
import { request, errorMessage } from "../lib/api";
import { invalidate, useResource } from "../lib/data";
import { deadline } from "../lib/presentation";
import { decisionBody, defaultTarget } from "../lib/review-presentation";
import { useStudent } from "./shell";
import { ErrorBox } from "./ui";
import { ReviewCardView } from "./review-card-view";

function ReviewCard({ review, timezone }: { review: SourceReview; timezone: string }) {
  const [action, setAction] = useState<ReviewAction>(review.recommendedAction);
  const [targetEventId, setTargetEventId] = useState(defaultTarget(review));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve() {
    setBusy(true);
    setError("");
    try {
      await request(`/reviews/${review.id}/resolve`, "POST", decisionBody(action, targetEventId));
      invalidate();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return <ReviewCardView review={review} action={action} targetEventId={targetEventId} busy={busy}
    formatDate={(iso) => deadline(iso, timezone)} onAction={setAction} onTarget={setTargetEventId} onConfirm={() => void resolve()}
    footer={<ErrorBox message={error} />} />;
}

// Hidden when nothing needs a decision; a review is a question, not an error.
export function ReviewQueue() {
  const resource = useResource<{ reviews: SourceReview[] }>("/reviews");
  const { timezone } = useStudent();
  if (!resource.data?.reviews.length && !resource.error) return null;
  return <section className="source-review-queue" id="source-reviews" aria-label="Needs your confirmation">
    <h3>Needs your confirmation</h3>
    <p>Ora found source updates it can&rsquo;t apply safely on its own. Nothing changes until you confirm.</p>
    <ErrorBox message={resource.error} retry={resource.refresh} />
    {resource.data?.reviews.map((review) => <ReviewCard key={`${review.id}:${review.updatedAt}`} review={review} timezone={timezone} />)}
  </section>;
}
