# CampusFlow — Complete Implementation Guide (3-Day Build)

## 0. What this document is

This is the single source of truth for building CampusFlow. It merges the product vision
(the "wow moment" demo) with a concrete, buildable spec: schemas, API contracts, prompts,
integration details, and an hour-by-hour phase plan. Hand this whole file to a coding agent
(Claude Code, Codex, etc.) one phase at a time — do not ask it to build everything at once.

**Do not deviate from the schemas and prompt contracts below without updating this file.**
Every downstream function assumes these shapes are exact.

---

## 1. Product Summary

College information is scattered across WhatsApp, PDFs, Google Classroom, email, and
timetables. Students don't lack information — they lack a system that turns that information
into a single, current, prioritized set of actions.

**CampusFlow ingests:** pasted text/notices, uploaded PDFs (notices, timetables), and live
Google Classroom announcements/coursework.

**CampusFlow produces:**
1. A **Truth Resolution Engine** — determines if new info is a new event, an update, a
   cancellation, or noise, and keeps one current schedule (no duplicate/stale events).
2. A **Scheduling & Conflict Engine** — detects workload collisions and generates a
   prioritized day-by-day action plan.
3. A **"What should I do today?"** dashboard — not a calendar, a reasoned task list.

**Explicit non-goals for this build:** no Gmail integration, no WhatsApp integration, no
multi-college multi-tenant auth, no mobile app. Single hardcoded/simple demo user is fine.

---

## 2. Tech Stack (unchanged from original scope — kept deliberately small)

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router) + TailwindCSS, hosted on AWS Amplify |
| Backend | API Gateway + AWS Lambda (Node.js 22) |
| Database | DynamoDB (single-table where sensible, see §3) |
| Storage/OCR | S3 + Amazon Textract (tables mode for timetables) |
| AI | Amazon Bedrock — Claude Sonnet, two distinct call types (extraction, reasoning) |
| Scheduling trigger | EventBridge Scheduler (polling Classroom, not push/Pub-Sub — see §5) |
| IaC | AWS SAM |
| Auth for Classroom | Google OAuth2 (googleapis Node SDK) — this is the only "real" external
  integration in scope |

**Why polling, not Classroom push notifications:** Push requires a Google Cloud Pub/Sub topic,
domain verification, and renewal-watch logic — too much setup risk for a 3-day window.
Polling every 10–15 minutes via EventBridge is functionally identical for a demo and takes
a fraction of the setup time.

---

## 3. Data Model (DynamoDB)

### Table: `StudentProfile`
| Field | Type | Notes |
|---|---|---|
| `userId` (PK) | String | hardcoded `demo-user` for the hackathon |
| `name` | String | |
| `program`, `year`, `section` | String | used for "applies to" filtering |
| `classroomTokens` | Map | `{ accessToken, refreshToken, expiresAt }` — see §9 on secret handling |
| `connectedCourses` | List<String> | Google Classroom course IDs the student selected |
| `timetableSlots` | List<Map> | recurring weekly slots, see §6 output shape |

### Table: `AcademicEvents`
| Field | Type | Notes |
|---|---|---|
| `userId` (PK) | String | |
| `eventId` (SK) | String | UUID |
| `title` | String | |
| `type` | String | `Exam \| Assignment \| Admin \| Lecture \| Club \| Lab` |
| `currentDeadline` | String (ISO) | |
| `venue` | String | nullable |
| `estimatedHours` | Number | effort to complete |
| `status` | String | `ACTIVE \| CANCELLED \| DONE` |
| `sourceType` | String | `manual \| pdf \| classroom` |
| `sourceRef` | String | classroom courseWork ID, S3 key, or `null` |
| `priorityScore` | Number | computed by scheduling engine, see §7 |
| `changeHistory` | List<String> | human-readable change log |

### Table: `ClassroomSyncState`
| Field | Type | Notes |
|---|---|---|
| `userId` (PK) | String | |
| `courseId` (SK) | String | |
| `lastSyncedAt` | String (ISO) | used as the `updateTime` floor on next poll |

### Table: `ScheduleBlocks` (output of the scheduling engine, rebuilt on each timeline load)
| Field | Type | Notes |
|---|---|---|
| `userId` (PK) | String | |
| `date` (SK) | String (`YYYY-MM-DD`) | |
| `blocks` | List<Map> | `{ eventId, task, allocatedHours, priority }` |

---

## 4. Core Lambda Functions

### 4.1 `IngestionAndTruthEngine`
**Trigger:** API Gateway POST (`/ingest`) — accepts `{ text }` or `{ s3Key }`.
**Logic:**
1. If `s3Key`: run Textract, get raw text. If `text`: use as-is.
2. Query `AcademicEvents` for user's ACTIVE events in the next 14 days.
3. Call Bedrock with **Prompt 1** (§8).
4. Based on `action` in the response: `PutItem` (CREATE), `UpdateItem` + append to
   `changeHistory` (UPDATE), set `status = CANCELLED` (CANCEL), or no-op (IGNORE).
5. Return the updated event so the frontend can show the "⚡ CampusFlow detected a change" toast.

### 4.2 `ClassroomSyncEngine` (new — not in original doc)
**Trigger:** EventBridge Scheduler, every 10–15 min, for each user with `connectedCourses`.
**Logic:**
1. For each `courseId` in `connectedCourses`, read `ClassroomSyncState.lastSyncedAt`.
2. Call Classroom API: `courses.announcements.list` and `courses.courseWork.list`, filtered
   client-side to items with `updateTime > lastSyncedAt`.
3. For each new/updated item, format it into the same plain-text shape a pasted notice would
   have (e.g. `"[Classroom] CS301: New coursework 'Lab 4' due 2026-09-20T23:59, worth ungraded"`)
   and **call `IngestionAndTruthEngine`'s core logic directly** (shared function, not a second
   HTTP hop) so Classroom items go through the exact same Truth Resolution path as pasted text.
4. Update `ClassroomSyncState.lastSyncedAt`.

This is the key design decision: **Classroom is just another producer of text into the same
ingestion pipeline.** Do not build a parallel data path for it.

### 4.3 `TimetableIngestionEngine` (new — not in original doc)
**Trigger:** API Gateway POST (`/timetable`) after student uploads a PDF to S3.
**Logic:**
1. Run Textract in **TABLES** mode on the PDF (timetables are grids — table mode preserves
   row/column structure that plain text extraction destroys).
2. Pass the extracted table text to Bedrock with **Prompt 3** (§8) to normalize it into
   structured recurring weekly slots.
3. Write the result to `StudentProfile.timetableSlots`.
4. Return the parsed slots to the frontend for a confirm/edit step (Textract + LLM extraction
   on real-world scanned timetables will sometimes misread a cell — show the student a quick
   editable table before saving, don't silently trust it).

### 4.4 `TimelineAndConflictEngine`
**Trigger:** API Gateway GET `/timeline`.
**Logic:**
1. Fetch all ACTIVE `AcademicEvents` + `timetableSlots` (expanded into concrete dates for the
   next 7 days) for the user.
2. Run the **deterministic** scoring pass first (§7) — urgency, effort, type weight, 48-hour
   collision detection. Do this in plain code, not the LLM — you want conflict detection to be
   reliable and re-runnable, not subject to model variance.
3. Pass the scored events + detected collisions to Bedrock with **Prompt 2** (§8) to generate
   the human-readable collision message and the narrative day-by-day plan.
4. Write result to `ScheduleBlocks`, return the full timeline + conflict payload to the frontend.

**Why hybrid (code does the math, LLM does the explanation):** collision detection and hour
allocation are just arithmetic — don't let the model "reason" its way to a wrong total. Use it
for what it's actually good at: turning scored data into a clear, prioritized narrative.

---

## 5. Google Classroom Integration — Setup Detail

1. **Google Cloud Console:** create a project, enable the Google Classroom API, create OAuth
   2.0 credentials (Web application type), add your deployed frontend URL as an authorized
   redirect URI.
2. **Scopes needed (read-only, minimal):**
   - `https://www.googleapis.com/auth/classroom.courses.readonly`
   - `https://www.googleapis.com/auth/classroom.announcements.readonly`
   - `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
   - `https://www.googleapis.com/auth/classroom.profile.emails`
3. **OAuth consent screen:** keep it in **Testing** mode with your demo account(s) added as
   test users — do not attempt Google app verification, it isn't necessary for a hackathon
   demo and can take days.
4. **Flow:** frontend "Connect Google Classroom" button → standard OAuth redirect →
   backend exchanges code for tokens → store in `StudentProfile.classroomTokens` → frontend
   shows a course picker (`courses.list`) → student selects which courses to sync →
   write to `connectedCourses`.
5. **Token refresh:** `googleapis` SDK handles refresh automatically given a valid
   `refreshToken` — just re-persist the new `accessToken`/`expiresAt` after each use.

---

## 6. PDF Timetable Ingestion — Output Shape

`timetableSlots` on `StudentProfile` should look like this after Prompt 3 runs:

```json
[
  { "day": "Monday", "startTime": "09:00", "endTime": "10:30", "subject": "DSA", "type": "Lecture", "room": "204" },
  { "day": "Monday", "startTime": "14:00", "endTime": "16:00", "subject": "DSA", "type": "Lab", "room": "Lab-3" }
]
```

The scheduling engine expands these into concrete dated blocks for the next 7 days when
building the timeline — this is plain code (day-of-week math), not an LLM call.

---

## 7. Deterministic Scoring (run in code, not Bedrock)

For each ACTIVE event, compute:

```
urgencyScore   = max(0, 1 - hoursUntilDeadline / (14 * 24))   // closer deadline = higher
effortScore    = min(1, estimatedHours / 6)                    // normalize, cap at 1
typeWeight     = { Exam: 1.0, Assignment: 0.8, Admin: 0.5, Lab: 0.7, Club: 0.3, Lecture: 0.2 }
priorityScore  = (urgencyScore * 0.5) + (effortScore * 0.3) + (typeWeight * 0.2)
```

**Collision detection:** for any 48-hour rolling window, sum `estimatedHours` of all events
with deadlines in that window. If the sum exceeds a threshold (default: 6 hours), flag a
collision and pass the involved events to Bedrock for the narrative + redistribution plan.

Sort the dashboard's "Today" list by `priorityScore` descending — this is what produces the
🔴🟠🟡🟢 ordering in the demo, deterministically, every time.

---

## 8. Bedrock Prompts (exact contracts — do not alter field names)

### Prompt 1 — Truth Resolution Engine (used by `IngestionAndTruthEngine` and `ClassroomSyncEngine`)
```text
You are an Academic Truth Resolution Engine.
Here is a student's current active schedule: {CURRENT_EVENTS_JSON}
Here is a new message/document they just received: "{NEW_MESSAGE_TEXT}"
Source of this message: {SOURCE_TYPE}  // "manual" | "pdf" | "classroom"

Determine how this new message affects the schedule.
Respond ONLY in this strict JSON format, no preamble, no markdown fences:
{
  "action": "CREATE" | "UPDATE" | "CANCEL" | "IGNORE",
  "targetEventId": "id_of_event_to_update_or_cancel" (null if CREATE or IGNORE),
  "eventDetails": {
    "title": string,
    "type": "Exam" | "Assignment" | "Admin" | "Lecture" | "Club" | "Lab",
    "currentDeadline": "YYYY-MM-DDTHH:mm",
    "venue": string,
    "estimatedHours": number
  },
  "changeSummary": "Short explanation of what changed, if anything"
}
```

### Prompt 2 — Conflict Narrative Engine (used by `TimelineAndConflictEngine`, after code-side scoring)
```text
You are a student productivity engine. Do not recompute hours or dates — they are already
correct in the input. Your job is only to explain and sequence.

Current Date: {CURRENT_DATE}
Scored timeline: {SCORED_EVENTS_JSON}
Detected collisions (already computed, do not re-derive): {COLLISIONS_JSON}

Respond ONLY with valid JSON, no preamble, no markdown fences:
{
  "collisionDetected": boolean,
  "collisionMessage": string,
  "recommendedActionPlan": [
    { "date": "YYYY-MM-DD", "task": string, "allocateHours": number, "priority": "High|Medium|Low" }
  ]
}
```

### Prompt 3 — Timetable Normalization Engine (used by `TimetableIngestionEngine`)
```text
You are a timetable parser. You will receive raw text extracted from a table in a college
timetable PDF. It may be noisy or misaligned. Reconstruct it into a clean weekly schedule.

Raw extracted table text: {TEXTRACT_TABLE_TEXT}

Respond ONLY with valid JSON, no preamble, no markdown fences:
{
  "slots": [
    { "day": "Monday", "startTime": "HH:mm", "endTime": "HH:mm", "subject": string, "type": "Lecture" | "Lab" | "Tutorial", "room": string }
  ],
  "lowConfidenceRows": [ "any row you were unsure how to parse, verbatim, for the student to fix" ]
}
```

---

## 9. Secrets & Token Handling (hackathon-appropriate, not production-grade)

- Store `classroomTokens` directly on the `StudentProfile` item in DynamoDB — DynamoDB is
  encrypted at rest by default, which is sufficient for a demo. Do **not** log tokens.
- For a real production version, note in the pitch that this would move to AWS Secrets
  Manager — but don't spend hackathon hours building that now.

---

## 10. UI Direction — avoid the "generic AI app" look

The biggest visual tell of an AI-generated frontend is: purple/indigo gradient background,
Inter font, everything in a rounded white card with a soft shadow, an emoji in every heading,
and a centered hero with three feature cards below it. Avoid all of that by default.

**Concrete instructions for whoever (or whatever agent) builds the frontend:**
- Pick **one** accent color with intent (not default Tailwind `indigo-500`/`purple-600`) and
  use it sparingly — for priority indicators and one primary action, not as a background wash.
- Use a real type pairing: one distinct display/serif or characterful sans for headings
  (e.g. a variable grotesque), a plain workhorse font for body text. Not Inter for everything.
- Priority indicators: use color + a short label (`High`, `Due tomorrow`) rather than only
  emoji circles — emoji-only status is a strong "AI demo" tell. Keep at most one emoji per
  screen (e.g. the ⚡ change-detected toast), not one per list item.
- Dashboard layout should look like a **tool**, not a landing page: dense information,
  left-aligned, real hierarchy through type size/weight — not everything centered in a card
  with equal visual weight.
- No stock illustrations, no gradient blobs, no glassmorphism.
- Motion: one meaningful transition (the "detected a change" moment updating the timeline
  live) is worth far more than decorative micro-animations everywhere else.
- If using shadcn/ui components, override the default border-radius and shadow tokens —
  the out-of-the-box look is itself recognizable.

---

## 11. Code Minimalism Rules (give this to the agent verbatim)

- No abstraction for things used once. No generic "service layer" for a single Lambda.
- No unused scaffold code left over from `sam init`/`create-next-app` templates — delete it.
- One Lambda = one file where reasonable. Shared logic (Bedrock calls, DynamoDB clients) goes
  in a small `lib/` shared by handlers, not duplicated.
- No speculative config for features not in this doc (no multi-tenant, no i18n, no theming
  system beyond the one accent color).
- Prefer explicit code over clever generic helpers — this is a 3-day project a judge or
  teammate needs to read quickly.

---

## 13. Persistent Agent Context Block

Paste this at the top of every coding-agent session for this project:

```
Project: CampusFlow. Hackathon build, 3-day budget.
Stack: Next.js + Tailwind (Amplify), API Gateway + Lambda Node.js, DynamoDB, S3 + Textract, Bedrock (Claude Sonnet), SAM.
No Gmail/WhatsApp integration. Google Classroom integration IS in scope, via OAuth + polling (not push).
Demo user is hardcoded, no Cognito/multi-tenant auth.
Follow exact DynamoDB schemas and Bedrock prompt JSON contracts in campusflow-implementation.md — do not rename fields.
Conflict/collision math is computed in code, not by the LLM. The LLM only extracts, classifies, and narrates.
UI must not look like a generic AI-generated app: no purple gradients, no Inter-everywhere, no card-with-shadow-for-everything, minimal emoji.
Write minimal, readable code. No unused scaffolding, no speculative abstraction.
```

## 14. Approved Phase 1 implementation amendment

Lambda uses Node.js 22 instead of the deprecated Node.js 20 runtime, as proposed
in preparation and accepted when Phase 1 was authorized. The schemas and all
three Bedrock prompt contracts above are unchanged. See phase-1-decisions.md
for implementation conventions and unresolved later-phase questions.

## 15. Approved Bedrock model amendment

CampusFlow uses Amazon Nova Pro (`amazon.nova-pro-v1:0`) instead of the previous
Bedrock partner model because the AWS account cannot authorize third-party
models. In
`ap-south-1`, invocation uses the required APAC system inference profile ID
`apac.amazon.nova-pro-v1:0`. The three prompt texts, JSON contracts, validation,
truth-resolution logic, deterministic scheduling, and architecture are unchanged.

## 16. Approved interchangeable AI-provider amendment

AI model transport is selected with `AI_PROVIDER` and does not change the three
prompt definitions or their JSON contracts:

- `ollama` uses the local Ollama chat API with `OLLAMA_BASE_URL` and
  `OLLAMA_MODEL` (`qwen3:8b` by default). It is local/demo only.
- `bedrock` uses the existing Converse API with configurable
  `BEDROCK_MODEL_ID`.

AWS Lambda must never attempt to connect to Ollama on a developer laptop. The
truth-resolution logic, deterministic planner math, schemas, API paths,
Classroom flow, PDF/Textract flow, DynamoDB tables, and frontend remain
unchanged.
