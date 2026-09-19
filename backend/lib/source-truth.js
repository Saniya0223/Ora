// Trusted transport metadata, never model-generated URLs or identities.
export function classroomSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "classroom.google.com"
      && !url.username && !url.password && !url.port && value.length <= 2000 ? url.href : null;
  } catch { return null; }
}

export function sameSource(event, notice) {
  return event.sourceType === notice.sourceType && notice.sourceRef !== null
    && (event.sourceRef === notice.sourceRef || Boolean(event.sourceMeta?.versions?.[notice.sourceRef]));
}

export function sameCourse(event, notice) {
  if (notice.sourceType !== "classroom") return true;
  return event.sourceType === "classroom" && event.sourceRef?.split(":")[0] === notice.sourceRef?.split(":")[0];
}

export function meaningfulChange(before, after, at, sourceRef) {
  const fields = [];
  const add = (field, previous, next) => {
    if (previous !== next) fields.push({ field, before: previous ?? null, after: next ?? null });
  };
  for (const field of ["currentDeadline", "venue", "status", "title"]) add(field, before[field], after[field]);
  for (const field of ["instructions", "requirements", "topics", "links", "submissionMethod", "certainty"]) {
    const value = (event) => {
      const item = event.details?.[field];
      if (field === "links") return (item ?? []).map((link) => link.url).join("\n") || null;
      return Array.isArray(item) ? item.join("\n") || null : item ?? null;
    };
    add(field, value(before), value(after));
  }
  return fields.length ? { at, sourceRef, fields } : null;
}

export function syncFailureCategory(code) {
  if (["UNKNOWN_TARGET", "AMBIGUOUS_SOURCE", "SOURCE_CLOSED", "OUTSIDE_COMPARISON_WINDOW", "TOO_MANY_ITEMS", "SCHEDULE_TOO_LARGE"].includes(code)) return "needsReview";
  if (["INVALID_MODEL_RESPONSE", "INVALID_RESPONSE"].includes(code)) return "validationFailed";
  if (code === "EVENT_CHANGED") return "raceSkipped";
  return "temporaryFailed";
}
