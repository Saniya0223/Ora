# CampusFlow frontend–backend contract

This is the complete contract between the CampusFlow frontend and backend. Every route listed here is implemented. Nothing here is planned or aspirational. If a route or field is not in this document, it does not exist.

The last section maps each screen (Dashboard, Tasks, Planner, Add & Setup) to the calls it needs.

---

## 1. Conventions

### Base URL and requests

- Base URL: the value of `NEXT_PUBLIC_API_BASE_URL` (the deployed API Gateway URL, or `http://localhost:3001` locally).
- Request bodies are JSON. Send `Content-Type: application/json`.
- Responses are JSON with `Cache-Control: no-store`. The only exception is the calendar export, which returns `text/calendar`.
- CORS allows the configured frontend origin with methods `GET, POST, PUT, PATCH, DELETE` and the `Content-Type` header.

### User scope and authentication

CampusFlow has a single student, `demo-user`. There is no login and no auth header. The server fixes the user on every request; no request can name or reach another user's data. The frontend never sends a user ID.

### Formats

| Kind | Format | Example |
|---|---|---|
| Timestamp (instant) | ISO-8601 UTC with milliseconds and `Z` | `"2026-09-21T13:30:00.000Z"` |
| Date | `YYYY-MM-DD`, in the student's timezone | `"2026-09-21"` |
| Clock time | `HH:mm`, 24-hour, in the student's timezone | `"18:00"` |
| Duration | integer **minutes**, unless the field name says otherwise | `180` |
| IDs | UUID strings. Generated study blocks use `gen-<24 hex>` | `"5f0c…"`, `"gen-9a1b…"` |

The student's timezone comes from their profile (`timezone`, default `Asia/Kolkata`). "Today", "next class", the academic week, and planner days are all computed server-side in that zone. The frontend should render instants in the same zone. It never needs to do timezone arithmetic to decide what belongs to a day.

**`null` means unknown, never zero.** For example, `estimatedMinutes: null` means nobody knows the effort. `0` would mean no effort is required. The same rule applies to `progress.timePercent`, `academicWeek`, and similar fields.

### Enums

| Enum | Values |
|---|---|
| `TaskStatus` | `OPEN`, `COMPLETED`, `CANCELLED` |
| `Priority` | `HIGH`, `MEDIUM`, `LOW` |
| `PriorityReason` | `OVERDUE`, `DUE_WITHIN_48_HOURS`, `EXAM_WITHIN_4_DAYS`, `HIGH_WORKLOAD_PRESSURE`, `MODERATE_WORKLOAD_PRESSURE`, `DUE_WITHIN_7_DAYS`, `DUE_LATER`, `NO_DEADLINE` |
| `TaskType` | `EXAM`, `ASSIGNMENT`, `LAB`, `LECTURE`, `ADMIN`, `CLUB`, `OTHER` |
| `TaskSource` | `CLASSROOM`, `MANUAL_NOTICE` (pasted notice), `PDF` (uploaded notice), `MANUAL` (created directly) |
| `EstimateSource` | `STUDENT`, `SOURCE`, `AI`, or `null` |
| `BlockType` | `STUDY`, `CLASS`, `LAB`, `EVENT`, `OTHER` |
| `FocusStatus` | `ACTIVE`, `PAUSED`, `COMPLETED`, `CANCELLED` |
| `SyncStatus` | `NEVER_SYNCED`, `SYNCING`, `SUCCESS`, `PARTIAL`, `ERROR`, `REAUTH_REQUIRED` |
| `SourceHealth` | `DISCONNECTED`, `NEVER_SYNCED`, `SYNCING`, `HEALTHY`, `STALE`, `ERROR`, `REAUTH_REQUIRED` |

### Error shape

Every error response has this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": [{ "field": "title", "issue": "Too small: expected string to have >=1 characters" }] } }
```

`details` is present only on validation and source-management errors. `message` is safe to show to the student. Raw AWS, Google, or Groq errors, stack traces, and secrets never appear in a response.

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | The body or query failed validation; `details` lists the fields. |
| 404 | `NOT_FOUND` | Unknown route, or the task, item, session, block, or slot does not exist. |
| 405 | `METHOD_NOT_ALLOWED` | The path exists but not with this method. |
| 409 | `CONFLICT` | The action does not fit the current state, e.g. completing a cancelled task. |
| 409 | `SOURCE_MANAGED` | Tried to edit or delete a field or task owned by a connected source; `details` lists the fields. |
| 409 | `PROFILE_REQUIRED` | Save the student profile first. |
| 409 | `FOCUS_SESSION_ACTIVE` | Another focus session is live; `details[0].issue` holds its session ID. |
| 409 | `UPLOAD_NOT_FOUND` | Attachment confirmed or downloaded before the upload finished. |
| 409 | `CLASSROOM_NOT_CONNECTED` | Sync requested without Google Classroom connected and courses chosen. |
| 409 | `SYNC_IN_PROGRESS` | A Classroom sync is already running. |
| 409 | `REAUTH_REQUIRED` | Google access was revoked or expired; reconnect Classroom. |
| 413 | `PAYLOAD_TOO_LARGE` | The body exceeds 100 KB. |
| 502 | `SYNC_FAILED` | Classroom could not be synced; safe to retry. |
| 503 | `PROVIDER_UNAVAILABLE` | Groq (AI) is unavailable for this request. |
| 503 | `NOT_CONFIGURED` | That backend capability is not deployed or configured. |
| 503 | `SERVICE_UNAVAILABLE` | Temporary failure; safe to retry. |

Routes that existed before this contract (notice ingestion, profile, timetable, documents, and the Classroom OAuth routes) keep their original error codes. They are listed under each of those routes.

---

## 2. Canonical types

These TypeScript types describe responses exactly. Fields marked `| null` are always present and may be `null`. No field is ever omitted.

```ts
type ISODateTime = string; // "2026-09-21T13:30:00.000Z"
type ISODate = string;     // "2026-09-21"
type ClockTime = string;   // "18:00"

type Course = { id: string | null; name: string | null };

// Returned by list views and embedded in the dashboard.
type TaskListItem = {
  id: string;
  academicEventId: string | null;   // set when the task comes from a source
  isSourceBacked: boolean;          // true: title/course/type/deadline are read-only
  source: "CLASSROOM" | "MANUAL_NOTICE" | "PDF" | "MANUAL";
  sourceRef: string | null;         // Classroom: "<courseId>:<kind>:<itemId>"
  sourceStatus: "ACTIVE" | "CANCELLED" | "DONE" | null; // the source's own status
  title: string;
  course: Course | null;
  type: TaskType;
  deadline: ISODateTime | null;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  completedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;
  isOverdue: boolean;               // OPEN and past its deadline
  calculatedPriority: Priority | null;   // null unless OPEN
  priorityReason: PriorityReason | null;
  manualPriorityOverride: Priority | null;
  effectivePriority: Priority | null;    // override ?? calculated; null unless OPEN
  estimatedMinutes: number | null;       // effective estimate; null = unknown
  estimateSource: "STUDENT" | "SOURCE" | "AI" | null;
  actualMinutes: number;                 // focus minutes logged
  remainingMinutes: number | null;       // max(0, estimate − actual); null if unknown
  progress: {
    timePercent: number | null;          // actual/estimate, 0–100; null if no estimate
    actualMinutes: number;
    estimatedMinutes: number | null;
  };
  checklistProgress: { done: number; total: number; percent: number | null }; // null when empty
  bookmarked: boolean;
  attachmentCount: number;               // READY attachments only
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  version: number;                       // informational
};

// Returned by single-task routes.
type TaskDetail = TaskListItem & {
  studentEstimatedMinutes: number | null;
  sourceEstimatedMinutes: number | null;
  aiEstimate: {
    estimatedMinutes: number;
    workUnits: { title: string; minutes: number }[];   // advisory steps, 1–8
    rationale: string;
    model: string | null;                              // "openai/gpt-oss-120b"
    generatedAt: ISODateTime;
  } | null;
  details: TaskSourceDetails | null;                   // source-owned detail; null for manual tasks and older items
  notes: string;                                       // plain text / simple markdown
  checklist: ChecklistItem[];                          // in display order
  attachments: Attachment[];
};

// What the source says about the work, extracted from the notice or Classroom
// post. Read-only for the student; refreshed when the source changes. Every
// value is source-supported: empty lists and nulls mean "not stated".
type TaskSourceDetails = {
  actionSummary: string | null;      // what the student must do, one sentence
  instructions: string[];            // steps, in order
  requirements: string[];            // things to bring or have
  topics: string[];                  // syllabus / chapters
  submissionMethod: string | null;
  links: { label: string | null; url: string }[]; // only URLs present in the source text
  venue: string | null;
  certainty: "confirmed" | "tentative";
  tentativeDeadline: ISODateTime | null; // set only when tentative; `deadline` is then null
  deadlineText: string | null;       // the source's own words, e.g. "tomorrow 6 PM"
  postedAt: ISODateTime | null;      // when the source was posted
  updatedAt: ISODateTime | null;     // when the source was last edited
};

type ChecklistItem = { id: string; text: string; done: boolean; createdAt: ISODateTime; completedAt: ISODateTime | null };

type Attachment = {
  id: string; fileName: string; contentType: string; size: number; // bytes
  status: "PENDING" | "READY"; createdAt: ISODateTime;
};

type FocusSession = {
  id: string; taskId: string; taskTitle: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  plannedMinutes: number;          // default 25
  startedAt: ISODateTime;
  pausedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;
  completedMinutes: number | null; // minutes credited to the task
  elapsedSeconds: number;          // server-measured focus time, excluding pauses
  isRunning: boolean;              // status === "ACTIVE"
};

type ScheduleBlock = {
  id: string;
  taskId: string | null;
  type: BlockType;
  title: string;
  start: ISODateTime;
  end: ISODateTime;
  generated: boolean;              // true = created by the planner
  status: "PLANNED";
  isPast: boolean;                 // end <= now
  outsidePreferredWindow: boolean; // placed outside the preferred window to fit a deadline
  location: string | null;
};

type ClassOccurrence = {
  id: string;                      // "class:<slotId>:<date>"
  slotId: string | null;
  date: ISODate;
  type: "CLASS" | "LAB";
  classType: "Lecture" | "Lab" | "Tutorial";
  title: string;                   // subject
  start: ISODateTime;
  end: ISODateTime;
  location: string | null;         // room
};

type Capacity = {
  atRisk: boolean;                 // true when any item cannot fit
  totalUnscheduledMinutes: number;
  items: {
    taskId: string; title: string; deadline: ISODateTime | null;
    requiredMinutes: number; scheduledMinutes: number; unscheduledMinutes: number;
    reason: "INSUFFICIENT_CAPACITY" | "DEADLINE_PASSED";
    message: string;               // e.g. "3 h 10 min of DBMS Assignment cannot fit before Wed 23 Sept, 23:59."
  }[];
  unestimatedTasks: { taskId: string; title: string; deadline: ISODateTime | null }[]; // cannot be planned until sized
  deferred: { taskId: string; title: string; deadline: ISODateTime | null; unscheduledMinutes: number }[]; // due beyond the 14-day horizon
};

type TimetableSlot = {
  id: string;
  day: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";
  startTime: ClockTime; endTime: ClockTime;
  subject: string;
  type: "Lecture" | "Lab" | "Tutorial";
  room: string;                    // may be ""
};

type TimetableSource = {
  kind: "PDF" | "MANUAL"; fileName: string | null; jobId: string | null;
  importedAt: ISODateTime; updatedAt: ISODateTime;
};

type Preferences = {
  dailyStudyHours: number;         // 1–12, in steps of 0.25
  preferredStudyStart: ClockTime;  // must be before preferredStudyEnd
  preferredStudyEnd: ClockTime;
  autoScheduleStudyBlocks: boolean;
  avoidClassConflicts: boolean;
  timezone: string;                // IANA, e.g. "Asia/Kolkata"
};

type SyncResult = {
  coursesScanned: number; announcementsScanned: number; courseworkScanned: number;
  processed: number; created: number; updated: number; cancelled: number; ignored: number; failed: number;
  truncated: boolean;              // stopped at the time budget; the rest resumes next run
  // Optional: absent on results recorded before these existed.
  ignoredReasons?: {               // sums to `ignored`
    modelIgnored: number;          // nothing trackable in the post
    alreadyProcessed: number;      // the same post was ingested before
    duplicate: number;             // an equal item already existed
    noChange: number;              // an update restated known information
  };
  rateLimited?: boolean;           // the AI provider was still rate limiting; the rest resumes next run
};

type ClassroomSyncStatus = {
  status: "SYNCING" | "SUCCESS" | "PARTIAL" | "ERROR" | "REAUTH_REQUIRED";
  trigger: "scheduled" | "manual";
  lastAttemptAt: ISODateTime;
  lastFinishedAt: ISODateTime | null;
  lastSuccessfulSyncAt: ISODateTime | null;
  lastErrorCode: string | null;    // e.g. REAUTH_REQUIRED, GOOGLE_CLIENT_CONFIG, CLASSROOM_ACCESS_DENIED, SYNC_FAILED
  lastResult: SyncResult | null;
};
```

---

## 3. Dashboard

### `GET /dashboard`

Everything the Dashboard shows, in one call. It may also refresh the study plan first (see [Planning behavior](#planning-behavior)).

**Request:** no parameters.

**Response 200**

```ts
{
  profile: { name: string; program: string; year: string; section: string; semester: string | null; academicWeek: number | null };
  date: { now: ISODateTime; today: ISODate; weekday: string; timezone: string };
  summary: {
    tasksToday: number;          // OPEN tasks due today or overdue, or with a study block today
    highPriority: number;        // how many of tasksToday have effectivePriority HIGH
    highPriorityOpen: number;    // all OPEN tasks with effectivePriority HIGH
    overdue: number;             // OPEN tasks past their deadline
    plannedStudyMinutes: number; // minutes of STUDY blocks on today's calendar, past or future
    completedToday: number;      // tasks completed today
  };
  nextClass: { title: string; classType: string; type: "CLASS" | "LAB"; start: ISODateTime; end: ISODateTime; location: string | null; inProgress: boolean } | null;
  priorities: (TaskListItem & { dueToday: boolean; scheduledToday: boolean })[]; // top 5 OPEN tasks
  completedToday: TaskListItem[];  // up to 5
  todaySchedule: {
    id: string; kind: "CLASS" | "LAB" | "STUDY" | "EVENT" | "OTHER"; title: string;
    classType: string | null; start: ISODateTime; end: ISODateTime; location: string | null; taskId: string | null;
    isPast: boolean; isCurrent: boolean; isNext: boolean; // exactly one item is isNext, unless nothing is left today
  }[];                           // chronological
  capacity: Capacity | null;
  sync: { classroom: { connection: "CONNECTED" | "DISCONNECTED"; health: SourceHealth; status: SyncStatus; lastSuccessfulSyncAt: ISODateTime | null } };
}
```

- `academicWeek` is week 1 for the week containing `semesterStartDate`, computed in the student's zone. It is `null` before the semester starts or when no start date is saved.
- `nextClass` is the first class, up to 7 days ahead, that has not ended yet. `inProgress` is true while it is running.
- `priorities` is sorted by `effectivePriority`, then by deadline.

**Example response (abridged)**

```json
{
  "profile": { "name": "Maya Lin", "program": "CS", "year": "3", "section": "A", "semester": "Spring 2026", "academicWeek": 8 },
  "date": { "now": "2026-09-21T06:30:00.000Z", "today": "2026-09-21", "weekday": "Monday", "timezone": "Asia/Kolkata" },
  "summary": { "tasksToday": 2, "highPriority": 1, "highPriorityOpen": 1, "overdue": 0, "plannedStudyMinutes": 270, "completedToday": 1 },
  "nextClass": { "title": "DSA Lab", "classType": "Lab", "type": "LAB", "start": "2026-09-21T08:30:00.000Z", "end": "2026-09-21T10:30:00.000Z", "location": "Lab 3", "inProgress": false },
  "priorities": [{ "id": "…", "title": "DSA Midterm Mock Exam", "effectivePriority": "HIGH", "priorityReason": "DUE_WITHIN_48_HOURS", "dueToday": false, "scheduledToday": true, "progress": { "timePercent": 33, "actualMinutes": 60, "estimatedMinutes": 180 }, "…": "…" }],
  "todaySchedule": [
    { "id": "class:…:2026-09-21", "kind": "LAB", "title": "DSA Lab", "classType": "Lab", "start": "2026-09-21T08:30:00.000Z", "end": "2026-09-21T10:30:00.000Z", "location": "Lab 3", "taskId": null, "isPast": false, "isCurrent": false, "isNext": true },
    { "id": "gen-…", "kind": "STUDY", "title": "DSA Midterm Mock Exam", "classType": null, "start": "2026-09-21T12:30:00.000Z", "end": "2026-09-21T14:30:00.000Z", "location": null, "taskId": "…", "isPast": false, "isCurrent": false, "isNext": false }
  ],
  "capacity": { "atRisk": false, "totalUnscheduledMinutes": 0, "items": [], "unestimatedTasks": [], "deferred": [] },
  "sync": { "classroom": { "connection": "CONNECTED", "health": "HEALTHY", "status": "SUCCESS", "lastSuccessfulSyncAt": "2026-09-21T06:15:02.000Z" } }
}
```

**Errors:** `PROFILE_REQUIRED` (409), `NOT_CONFIGURED` (503), `SERVICE_UNAVAILABLE` (503).

---

## 4. Tasks

A **Task** is what the student acts on. Tasks from Google Classroom, a pasted notice, or a PDF notice are **source-backed**: they are linked to an AcademicEvent, and their `id` equals that event's ID. The backend creates and updates them automatically. A source cannot create duplicates, and a source cancellation cancels the task.

| Field group | Source-backed task | Manual task |
|---|---|---|
| `title`, course, `type`, `deadline` | read-only (the source owns them) | editable |
| `estimatedMinutes` (student's own), `manualPriorityOverride`, `notes`, `bookmarked`, checklist, attachments, focus | editable | editable |
| Delete | not allowed (`SOURCE_MANAGED`) | allowed |

When a source cancels a task that is still `OPEN`, the task becomes `CANCELLED`. A task the student already completed stays `COMPLETED`, and its `sourceStatus` becomes `CANCELLED`.

### `GET /tasks`

Lists tasks with server-side filtering, search, sorting, and tab counts.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `view` | `all` \| `upcoming` \| `high_priority` \| `completed` \| `cancelled` | `all` | `all` = OPEN + COMPLETED. `upcoming` = OPEN with a future deadline. `high_priority` = OPEN with effectivePriority HIGH. |
| `q` | string (≤100) | – | Case-insensitive match on title or course name |
| `course` | string | – | Exact course ID or course name (case-insensitive) |
| `type` | `TaskType` | – | |
| `status` | `TaskStatus` | – | Overrides `view` for the list |
| `bookmarked` | `true` \| `false` | – | |
| `from`, `to` | `YYYY-MM-DD` | – | Deadline on or between these dates, in the student's zone |
| `sort` | `priority` \| `deadline` \| `updated` | `priority` | `priority`: OPEN first, then effectivePriority, then deadline |

**Response 200**

```ts
{ tasks: TaskListItem[]; counts: { all: number; upcoming: number; highPriority: number; completed: number; cancelled: number } }
```

`counts` respect `q`, `course`, `type`, `bookmarked`, `from` and `to`, but ignore `view` and `status`. The tab badges therefore stay stable while the student switches tabs.

**Example:** `GET /tasks?view=upcoming&q=dsa` → `{ "tasks": [ … ], "counts": { "all": 8, "upcoming": 5, "highPriority": 2, "completed": 1, "cancelled": 0 } }`

**Errors:** `VALIDATION_ERROR` (unknown view, bad date), `NOT_CONFIGURED`, `SERVICE_UNAVAILABLE`.

### `POST /tasks`

Creates a manual task.

```ts
{
  title: string;                        // required, 1–300
  courseName?: string | null;           // 1–100
  type?: TaskType;                      // default OTHER
  deadline?: string | null;             // ISO instant with offset, or local "YYYY-MM-DDTHH:mm" read in the student's zone
  estimatedMinutes?: number | null;     // integer 1–10000
  manualPriorityOverride?: Priority | null;
  notes?: string;                       // ≤20000
  checklist?: string[];                 // item texts, ≤100
}
```

**Example:** `{ "title": "OS Semaphore Lab Report", "courseName": "CS342", "type": "LAB", "deadline": "2026-10-20T23:59", "estimatedMinutes": 240 }`

**Response 201:** `{ task: TaskDetail }`

**Errors:** `VALIDATION_ERROR`; unknown fields are rejected.

### `GET /tasks/{taskId}`

**Response 200:** `{ task: TaskDetail }`. **Errors:** `NOT_FOUND`.

### `PATCH /tasks/{taskId}`

Edits allowed fields. Send only the fields that change; send at least one.

```ts
{ title?: string; courseName?: string | null; type?: TaskType; deadline?: string | null;   // manual tasks only
  estimatedMinutes?: number | null;       // the student's own estimate; null clears it
  manualPriorityOverride?: Priority | null; notes?: string; bookmarked?: boolean }
```

**Response 200:** `{ task: TaskDetail }`

**Errors:**
- `SOURCE_MANAGED` (409) when a source-backed task receives `title`, `courseName`, `type` or `deadline`. `details` names each field.
- `VALIDATION_ERROR`.
- `NOT_FOUND`.
- `CONFLICT`.

### `DELETE /tasks/{taskId}`

Deletes a **manual** task, its attachment files, and its future generated study blocks. Focus-session history is kept.

**Response 200:** `{ deleted: true, id: string }`. **Errors:** `SOURCE_MANAGED` (source-backed task), `NOT_FOUND`.

### `POST /tasks/{taskId}/complete` and `POST /tasks/{taskId}/reopen`

- **Complete** marks the task `COMPLETED` and removes its future generated study blocks. Past blocks and focus history are kept. Completing an already-completed task changes nothing.
- **Reopen** returns the task to `OPEN`. The next planning pass can schedule its remaining work again.

**Response 200:** `{ task: TaskDetail }`. **Errors:** `CONFLICT` (completing or reopening a task the source cancelled), `NOT_FOUND`.

### `PUT /tasks/{taskId}/bookmark`

Body `{ bookmarked: boolean }`. **Response 200:** `{ task: TaskDetail }`.

### `PUT /tasks/{taskId}/notes`

Body `{ notes: string }` (≤20000; replaces the notes). **Response 200:** `{ task: TaskDetail }`.

### `POST /tasks/{taskId}/estimate`

Asks GPT-OSS 120B to estimate the effort and split the work into steps. The result is stored in `aiEstimate`. It becomes the effective estimate only when neither the student nor the source has given one. The estimate is advisory: it never changes the checklist and never places blocks.

**Request:** no body. **Response 200:** `{ task: TaskDetail }`

**Errors:** `PROVIDER_UNAVAILABLE` (503; the student can still type an estimate), `NOT_CONFIGURED`, `NOT_FOUND`.

The backend also estimates up to 3 unsized OPEN tasks automatically after each scheduled Classroom sync, as a best-effort step.

### Progress semantics

- `progress.timePercent = min(100, round(actualMinutes / estimatedMinutes × 100))`. It is `null` when there is no estimate.
- `checklistProgress.percent` is a **separate** metric. The two are never combined.
- `actualMinutes` grows only through completed focus sessions.

---

## 5. Checklist

Items have stable IDs and keep their order.

| Route | Body | Response |
|---|---|---|
| `POST /tasks/{taskId}/checklist` | `{ text: string }` (1–300) | **201** `{ item: ChecklistItem, task: TaskDetail }` |
| `PATCH /tasks/{taskId}/checklist/{itemId}` | `{ text?: string; done?: boolean }` (at least one) | **200** `{ task: TaskDetail }` |
| `DELETE /tasks/{taskId}/checklist/{itemId}` | – | **200** `{ task: TaskDetail }` |
| `PUT /tasks/{taskId}/checklist/order` | `{ itemIds: string[] }`, every current ID exactly once | **200** `{ task: TaskDetail }` |

Setting `done: true` stamps `completedAt`; setting `done: false` clears it. **Errors:** `VALIDATION_ERROR`, `NOT_FOUND` (task or item), `CONFLICT` (more than 100 items).

---

## 6. Attachments

Files are stored privately. The frontend never receives bucket URLs, storage keys, or credentials. It gets short-lived signed links only.

**Accepted files:** PDF, PNG, JPEG, plain text, and `.docx`, up to 10 MB each and 20 per task.

Uploading takes three steps:

1. **`POST /tasks/{taskId}/attachments`** with body `{ fileName: string; contentType: string; size: number }`.
   **Response 201:** `{ attachment: Attachment /* PENDING */, upload: { url: string; fields: Record<string,string> }, expiresInSeconds: 300 }`
2. **Upload the file straight to storage.** Send a `multipart/form-data` `POST` to `upload.url`. Include every entry of `upload.fields` as a form field, then the file as the **last** field, named `file`. Do not add a `Content-Type` header yourself.
3. **`POST /tasks/{taskId}/attachments/{attachmentId}/confirm`.** The server checks that the file arrived and matches the declared type and size. **Response 200:** `{ attachment: Attachment /* READY */ }`.

Other routes:

| Route | Response |
|---|---|
| `GET /tasks/{taskId}/attachments` | `{ attachments: Attachment[] }` |
| `GET /tasks/{taskId}/attachments/{attachmentId}/download` | `{ url, expiresInSeconds: 300, fileName, contentType }`. Open `url` to download; it expires after 5 minutes. |
| `DELETE /tasks/{taskId}/attachments/{attachmentId}` | `{ deleted: true, id }`. Deletes the stored file too. |

**Errors:** `VALIDATION_ERROR` (type or size), `UPLOAD_NOT_FOUND` (409; confirm or download before the upload finished), `CONFLICT` (20-file limit), `NOT_FOUND`, `NOT_CONFIGURED`.

---

## 7. Focus sessions

The browser runs the live countdown. The server stores only the transitions and measures the elapsed time itself. Only one session (`ACTIVE` or `PAUSED`) can be live at a time.

| Route | Body | Response |
|---|---|---|
| `POST /tasks/{taskId}/focus-sessions` | `{ plannedMinutes?: number }` (1–240, default 25) | **201** `{ session: FocusSession }` |
| `GET /tasks/{taskId}/focus-sessions` | – | **200** `{ sessions: FocusSession[] }`, newest first. Full history. |
| `GET /focus-sessions/active` | – | **200** `{ session: FocusSession \| null }`. Use it to restore a timer after a reload. |
| `POST /focus-sessions/{sessionId}/pause` | – | **200** `{ session }` |
| `POST /focus-sessions/{sessionId}/resume` | – | **200** `{ session }` |
| `POST /focus-sessions/{sessionId}/cancel` | – | **200** `{ session }`. Credits nothing. |
| `POST /focus-sessions/{sessionId}/complete` | `{ completedMinutes?: number }` (0–240) | **200** `{ session, alreadyCompleted: boolean, creditedMinutes: number, task: TaskDetail \| null }` |

**How completion credits time:**
- Without `completedMinutes`, the credit is the measured focus time excluding pauses, capped at `plannedMinutes`.
- With `completedMinutes`, the credit is that value, but never more than the measured time plus 1 minute.
- The credit is added to `task.actualMinutes`, so the task's progress updates in the same response.
- Completing is **idempotent**. A repeated call returns `alreadyCompleted: true` and `creditedMinutes: 0`, and adds nothing to the task.

**Resuming a timer after a reload:** remaining seconds = `plannedMinutes × 60 − session.elapsedSeconds`. Count down locally only while `isRunning` is true.

**Errors:** `FOCUS_SESSION_ACTIVE` (409; `details[0].issue` is the live session's ID), `CONFLICT` (task not OPEN, invalid transition), `NOT_FOUND`, `VALIDATION_ERROR`.

---

## 8. Planning preferences

### `GET /preferences`

**Response 200:** `{ preferences: Preferences }`. Defaults apply until the student saves: `4` hours, `18:00`–`23:00`, auto-schedule on, avoid class conflicts on, `Asia/Kolkata`. **Errors:** `PROFILE_REQUIRED`.

### `PUT /preferences`

Send any subset of the `Preferences` fields. Omitted fields keep their saved values.

**Example:** `{ "dailyStudyHours": 6, "preferredStudyStart": "18:00", "preferredStudyEnd": "23:00", "autoScheduleStudyBlocks": true, "avoidClassConflicts": true }`

**Response 200:** `{ preferences: Preferences }`

**Validation:**
- `dailyStudyHours` is between 1 and 12, in steps of 0.25.
- Times are `HH:mm`, and the window must start before it ends on the same day.
- `timezone` must be a valid IANA name.
- Unknown fields are rejected.

Violations return `VALIDATION_ERROR` with `details`. **Other errors:** `PROFILE_REQUIRED`.

Changes affect **future** planning only; past blocks and focus history are never rewritten.

---

## 9. Planner and schedule

### Planning behavior

The scheduler is **deterministic**: the same tasks, timetable and preferences always produce the same blocks with the same IDs. No AI model chooses times. Its rules:

- Only `OPEN` tasks are planned, and only their **remaining** effort (`estimate − actualMinutes`, minus study already booked from now on).
- Tasks are placed in order of `effectivePriority`, then deadline. No block ends after its task's deadline.
- Blocks are 30–120 minutes. A task's final remainder may be shorter. Blocks start on a 5-minute grid and are followed by a 10-minute break.
- **Hard limits:** `dailyStudyHours` across all study each day, no overlapping blocks, and no class overlaps when `avoidClassConflicts` is on.
- **Soft preferences**, relaxed in this order only when work would otherwise not fit before its deadline:
  1. the preferred study window, with at most 3 h of one task per day;
  2. the preferred window, without the per-task cap;
  3. the wider 08:00–22:00 day. Blocks placed here have `outsidePreferredWindow: true`.
- Tasks are planned up to 14 days ahead. Work due later is listed in `capacity.deferred`.
- Work that cannot fit before its deadline is **never** reported as fitting. It appears in `capacity.items`, with `atRisk: true` and a readable message.
- Tasks without an estimate cannot be placed. They are listed in `capacity.unestimatedTasks`.

**When plans change:**
- `GET /dashboard` and `GET /planner` refresh the plan automatically whenever an input changed. Inputs include tasks, estimates, progress, the timetable, preferences, manual blocks, and the date.
- If `autoScheduleStudyBlocks` is off, that refresh computes `capacity` but writes **no** study blocks.
- `POST /schedule/replan` always generates blocks.
- Replanning replaces only **future generated** blocks. It never touches past or in-progress blocks, manual blocks, timetable classes, or focus history.
- A generated block whose task is no longer `OPEN` is never returned.

### `GET /planner?from=YYYY-MM-DD&to=YYYY-MM-DD`

Returns the Week or Day view data for a date range: at most 42 days, `to` ≥ `from`, dates in the student's zone. Use `from = to` for the Day view.

**Response 200**

```ts
{
  range: { from: ISODate; to: ISODate; timezone: string };
  classes: ClassOccurrence[];        // the weekly timetable expanded onto dates
  blocks: ScheduleBlock[];           // study and manual blocks overlapping the range
  deadlines: { taskId: string; title: string; type: TaskType; course: Course | null; deadline: ISODateTime; status: TaskStatus }[];
  capacity: Capacity | null;
  planning: { lastPlannedAt: ISODateTime | null; autoScheduleStudyBlocks: boolean };
}
```

**Errors:** `VALIDATION_ERROR` (missing or invalid range, more than 42 days), `PROFILE_REQUIRED`.

### `GET /planner/export?from=YYYY-MM-DD&to=YYYY-MM-DD`

Exports classes, study and manual blocks, and deadlines as an RFC 5545 calendar, with all times in UTC. The range rules are the same as `/planner`.

**Response 200:** `Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="campusflow-<from>-to-<to>.ics"`. The body is the `.ics` text. Trigger a download from it.

### `POST /schedule/replan`

Replans now.

**Request:** no body. **Response 200:** `{ plannedAt: ISODateTime; removed: number; blocks: ScheduleBlock[]; capacity: Capacity }`

Safe to call repeatedly: identical inputs rebuild identical blocks.

**Example (capacity risk):**

```json
{ "plannedAt": "2026-09-21T06:30:00.000Z", "removed": 4, "blocks": [ … ],
  "capacity": { "atRisk": true, "totalUnscheduledMinutes": 190,
    "items": [{ "taskId": "…", "title": "DBMS Assignment", "deadline": "2026-09-23T18:29:00.000Z",
      "requiredMinutes": 900, "scheduledMinutes": 710, "unscheduledMinutes": 190, "reason": "INSUFFICIENT_CAPACITY",
      "message": "3 h 10 min of DBMS Assignment cannot fit before Wed 23 Sept, 23:59." }],
    "unestimatedTasks": [], "deferred": [] } }
```

### `POST /schedule/blocks` and `DELETE /schedule/blocks/{blockId}`

- **`POST /schedule/blocks`** adds a manual block. The planner treats it as busy time and never moves or deletes it. Manual `STUDY` blocks that name a `taskId` count toward that task's booked work.
  Body: `{ type: BlockType; title: string; start: ISODateTime; end: ISODateTime; taskId?: string | null; location?: string | null }`. The block must end after it starts and last at most 12 h.
  **Response 201:** `{ block: ScheduleBlock }`
- **`DELETE /schedule/blocks/{blockId}`** removes a manual block. **Response 200:** `{ deleted: true, id }`. Generated blocks cannot be deleted (`CONFLICT`); replan instead.

---

## 10. Timetable

The weekly timetable drives the next class, today's schedule, planner classes, and conflict avoidance.

### `GET /timetable`

**Response 200:** `{ slots: TimetableSlot[]; source: TimetableSource | null }`

Slots saved before slot IDs existed receive stable IDs on the first read.

### `PUT /timetable`

Replaces the whole timetable, either after reviewing a PDF import or as a manual save.

**Request**

```ts
{ slots: Omit<TimetableSlot, "id">[] | TimetableSlot[];   // ≤150; missing IDs are assigned
  source?: { fileName?: string | null; jobId?: string | null } }  // pass these after a PDF import
```

**Response 200:** `{ slots: TimetableSlot[]; source: TimetableSource }`

Passing `fileName` or `jobId` records `kind: "PDF"` with a new `importedAt`. Otherwise the previous provenance is kept and `updatedAt` changes.

**Errors:** `INVALID_TIMETABLE` (400), `PROFILE_REQUIRED` (409), `INVALID_JSON` (400).

### `PUT /timetable/slots/{slotId}`

Corrects one slot in place, keeping its ID.

**Request:** the slot fields `{ day, startTime, endTime, subject, type, room }`. **Response 200:** `{ slot: TimetableSlot; slots: TimetableSlot[]; source: TimetableSource }`. **Errors:** `INVALID_TIMETABLE` (400), `NOT_FOUND` (404).

### `DELETE /timetable/slots/{slotId}`

**Response 200:** `{ slots: TimetableSlot[]; source: TimetableSource | null }`. **Errors:** `NOT_FOUND`.

### Importing a timetable from a PDF

1. `POST /uploads`: see [PDF upload](#post-uploads).
2. `POST /timetable` with `{ s3Key }`. **Response 202:** `{ jobId, kind: "timetable", status: "PROCESSING" }`.
3. Poll `GET /documents/{jobId}` until `status` is `SUCCEEDED` or `FAILED`. On success, `result` is `{ slots: TimetableSlot[] /* no IDs */, lowConfidenceRows: string[] }`.
4. Show the slots to the student. **Timetables always require the student's review before saving.** Highlight `lowConfidenceRows`.
5. `PUT /timetable` with the reviewed slots and `source: { fileName, jobId }`.

---

## 11. Adding notices

A pasted or uploaded notice goes through the same path as Classroom:

> GPT-OSS 20B → Truth Resolution (CREATE / UPDATE / CANCEL / IGNORE) → AcademicEvent → Task

There is exactly one notice pipeline. A notice may contain several obligations
("Submit Assignment 3 by Friday. Quiz 2 is Monday."). Each becomes its own
item and Task. Relative dates ("tomorrow 6 PM") are read from when the notice
was posted; for pasted text, that is when it was received.

### `POST /ingest` (pasted text)

**Request:** `{ text: string }` (1–12,000 characters, the only field).

**Response:** 201 for `CREATE`, otherwise 200.

```ts
{ action: "CREATE" | "UPDATE" | "CANCEL" | "IGNORE"; // the first item that changed something
  event: AcademicEvent | null;          // null when nothing was tracked
  changeSummary: string;                // student-safe; explains an IGNORE too
  taskId?: string;                      // the linked Task (= event ID) when an event was written
  // Added fields; the four above keep their meaning.
  reason: "modelIgnored" | "alreadyProcessed" | "duplicate" | "noChange" | null; // why, for an IGNORE
  modelIgnoreReason?: "no_student_action" | "not_applicable" | "no_new_information" | "informational" | "uncertain" | "unspecified";
  partial: boolean;                     // true when some items of the notice could not be applied
  results: {                            // every item of the notice, in order
    action: "CREATE" | "UPDATE" | "CANCEL" | "IGNORE" | "FAILED";
    event: AcademicEvent | null; changeSummary: string; taskId?: string;
    reason: string | null; code?: string;  // code: the error code of a FAILED item
  }[] }
```

`AcademicEvent` is `{ userId, eventId, title, type: "Exam"|"Assignment"|"Admin"|"Lecture"|"Club"|"Lab", currentDeadline: ISODateTime | null, venue: string|null, estimatedHours, status: "ACTIVE"|"CANCELLED"|"DONE", sourceType, sourceRef, priorityScore, changeHistory: string[], details?, sourceMeta? }`. `currentDeadline` is `null` for an undated or tentative item. The UI should work with the linked Task (`GET /tasks/{taskId}`) rather than the raw event.

**Errors:**

| HTTP | `code` |
|---|---|
| 400 | `INVALID_JSON`, `INVALID_NOTICE` |
| 413 | `NOTICE_TOO_LARGE`, `SCHEDULE_TOO_LARGE` |
| 415 | `INVALID_CONTENT_TYPE` |
| 409 | `UNKNOWN_TARGET`, `OUTSIDE_COMPARISON_WINDOW`, `EVENT_CHANGED` |
| 502 | `INVALID_MODEL_RESPONSE` |
| 503 | `NOT_CONFIGURED`, `SERVICE_UNAVAILABLE` |
| 504 | `TIMEOUT` |

On `TIMEOUT`, refresh tasks before retrying, because the notice may have been applied.

### Notice PDFs

1. `POST /uploads`.
2. `POST /ingest` with `{ s3Key }` (the only field). **Response 202:** `{ jobId, kind: "notice", status: "PROCESSING" }`.
3. Poll `GET /documents/{jobId}`. On `SUCCEEDED`, `result` has the `/ingest` response shape above.

### `POST /uploads`

Starts a PDF upload for notice or timetable import.

**Request:** `{ fileName: string; contentType: "application/pdf"; size: number }` (≤10 MB).

**Response 200:** `{ s3Key: string; url: string; fields: Record<string,string> }`. Upload with a multipart `POST`, the same way as attachment step 2, then pass `s3Key` on.

**Errors:** `INVALID_PDF`, `INVALID_JSON`, `NOT_CONFIGURED`, `DOCUMENT_UNAVAILABLE`.

### `GET /documents/{jobId}`

**Response:** 202 while processing, otherwise 200.

```ts
{ jobId: string; kind: "notice" | "timetable"; status: "PROCESSING" | "SUCCEEDED" | "FAILED"; result?: object; error?: string }
```

`error` is a student-safe message. **Errors:** `INVALID_JOB` (400), `JOB_NOT_FOUND` (404), `NOT_CONFIGURED`, `DOCUMENT_UNAVAILABLE` (503).

### `GET /events` (legacy)

Returns `{ events: AcademicEvent[] }`: ACTIVE events sorted by deadline, undated or tentative ones (`currentDeadline: null`) last. It is used by the current UI. New screens should use `GET /tasks`.

---

## 12. Connected sources and Google Classroom

### `GET /sources`

**Response 200**

```ts
{
  classroom: {
    connection: "CONNECTED" | "DISCONNECTED";
    health: SourceHealth;
    account: { email: string | null; name: string | null } | null;   // filled after the first successful sync
    selectedCourses: { id: string; name: string | null; lastSyncedAt: ISODateTime | null }[];
    sync: {
      status: SyncStatus; trigger: "scheduled" | "manual" | null; stale: boolean;
      lastAttemptAt: ISODateTime | null; lastFinishedAt: ISODateTime | null;
      lastSuccessfulSyncAt: ISODateTime | null; lastErrorCode: string | null; lastResult: SyncResult | null;
    };
  };
  timetable: { status: "READY" | "NOT_IMPORTED"; slotCount: number; source: TimetableSource | null };
}
```

Health reflects **real sync results**. Holding Google credentials is never, on its own, reported as healthy.

| `health` | Meaning | Suggested UI |
|---|---|---|
| `DISCONNECTED` | No Google connection. | "Connect Google Classroom" |
| `NEVER_SYNCED` | Connected, but no sync has finished yet. | "Waiting for first sync" + Sync |
| `SYNCING` | A sync is running now. | Spinner |
| `HEALTHY` | The last sync succeeded (or was `PARTIAL`) within the last 45 minutes. | "Synced", with "Last synced …" from `lastSuccessfulSyncAt` |
| `STALE` | Connected, but no successful sync for more than 45 minutes. | Warning + Sync |
| `ERROR` | The last sync failed (`lastErrorCode`). `SYNC_INTERRUPTED` means a run died mid-way. | Error + Sync |
| `REAUTH_REQUIRED` | Google access expired or was revoked. | "Reconnect Google Classroom" |

`PARTIAL` means Classroom was reachable, but some items failed, the run hit its time budget, or the AI provider kept rate limiting (`lastResult.rateLimited`). Those items retry automatically on the next sync. `lastResult` has the counts, and `lastResult.ignoredReasons` says why items were ignored.

### `POST /classroom/sync` (Sync Now)

Runs the **same** production sync as the automatic 15-minute schedule. It uses a time budget that fits the API timeout; unfinished work resumes on the next run, and incremental checkpoints are preserved.

**Request:** no body. **Response 200:** `{ sync: ClassroomSyncStatus }`.

**Example:**

```json
{ "sync": { "status": "SUCCESS", "trigger": "manual", "lastAttemptAt": "2026-09-21T06:31:00.000Z",
  "lastFinishedAt": "2026-09-21T06:31:04.000Z", "lastSuccessfulSyncAt": "2026-09-21T06:31:04.000Z", "lastErrorCode": null,
  "lastResult": { "coursesScanned": 1, "announcementsScanned": 3, "courseworkScanned": 2, "processed": 1,
    "created": 1, "updated": 0, "cancelled": 0, "ignored": 0, "failed": 0, "truncated": false,
    "ignoredReasons": { "modelIgnored": 0, "alreadyProcessed": 0, "duplicate": 0, "noChange": 0 }, "rateLimited": false } } }
```

**Errors:** `CLASSROOM_NOT_CONNECTED` (409), `SYNC_IN_PROGRESS` (409), `REAUTH_REQUIRED` (409, with `sync`), `SYNC_FAILED` (502, with `sync` when known).

Refresh `GET /tasks` or `GET /dashboard` after a sync that created or updated items.

### Connecting Classroom and choosing courses

| Route | Purpose |
|---|---|
| `GET /classroom/connect` (alias `GET /classroom/auth/start`) | **200** `{ url }`. Navigate the browser to `url` for Google consent. Save the profile first: the callback needs it to store the connection. |
| `GET /classroom/callback` | Google redirects here. The backend stores the tokens (never returned) and redirects to `<frontend>/?classroom=connected`. The frontend does not call it. |
| `GET /classroom/courses` | **200** `{ courses: { id, name, section }[] }`: the student's active courses. |
| `PUT /classroom/courses` | Body `{ courseIds: string[] }` (≤100). **200** `{ connectedCourses: string[] }`. Selects the courses to sync. |

**Errors:**

| HTTP | `code` |
|---|---|
| 400 | `GOOGLE_DENIED`, `INVALID_OAUTH_STATE`, `INVALID_CALLBACK`, `INVALID_COURSES` |
| 409 | `CLASSROOM_NOT_CONNECTED`, `PROFILE_REQUIRED` |
| 502 | `GOOGLE_TOKEN_ERROR` |
| 503 | `NOT_CONFIGURED`, `CLASSROOM_UNAVAILABLE` |

---

## 13. Profile

### `GET /profile`

**Response 200**

```ts
{ profile: {
    name: string; program: string; year: string; section: string;
    semester: string | null; semesterStartDate: ISODate | null; timezone: string;
    academicWeek: number | null;
    connectedCourses: string[]; timetableSlots: TimetableSlot[];
  } | null }                        // null before the first save
```

Tokens are never returned.

### `PUT /profile`

Creates or updates the profile.

**Request**

```ts
{ name: string; program: string; year: string; section: string;   // required
  semester?: string | null; semesterStartDate?: ISODate | null; timezone?: string | null }  // null clears
```

**Response 200:** `{ profile }` (as above). Classroom connection, sync status, and planning data are never affected by a profile save. **Errors:** `INVALID_PROFILE` (400, with `details`).

---

## 14. Other routes

| Route | Notes |
|---|---|
| `GET /health` | **200** `{ status: "ok", service: "campusflow" }`. Liveness only. |
| `GET /timeline` | **Legacy**, used by the current "What should I do today?" panel. It returns `{ days, timetable, events, collisions, unallocated, collisionDetected, collisionMessage, recommendedActionPlan, narrativeSource }` from the older event-based allocator. New screens should use `/dashboard` and `/planner`. |

---

## 15. Screen-by-screen workflow map

| Screen or action | Calls |
|---|---|
| **Dashboard** | `GET /dashboard`. Use it for the greeting name, date, week, semester, the three summary cards, next class, today's priorities with Start Focus / Open Task, today's schedule with the "Next" badge, and the Synced indicator (`sync.classroom.health`). |
| Start Focus (dashboard or task) | `POST /tasks/{id}/focus-sessions` → countdown in the browser → `POST /focus-sessions/{sid}/complete`. On load, `GET /focus-sessions/active` resumes a running timer. |
| **Tasks** tabs (All / Upcoming / High Priority / Completed) | `GET /tasks?view=all\|upcoming\|high_priority\|completed` with `q` for search. Use `counts` for the badges. |
| New Task | `POST /tasks` |
| Task detail panel | `GET /tasks/{id}` gives the badge, due date, estimated effort (`estimatedMinutes`, `estimateSource`), progress (`progress.timePercent`, `actualMinutes`/`estimatedMinutes`), checklist, notes and attachments. |
| Checklist / Notes / Attachments tabs | Section 5 / `PUT /tasks/{id}/notes` / Section 6 |
| Bookmark icon | `PUT /tasks/{id}/bookmark` |
| Edit Task | `PATCH /tasks/{id}`. Disable the source-owned fields when `isSourceBacked` is true. |
| Mark Complete | `POST /tasks/{id}/complete` |
| "Estimate effort" (when `estimatedMinutes` is null) | `POST /tasks/{id}/estimate` |
| **Planner** Week / Day | `GET /planner?from=<Mon>&to=<Sun>` or `from=to=<day>`. Colour by `classes[].type` (Lecture/Lab) and `blocks[].type` (Study, Club/Event, and so on). Mark `deadlines` on their day. |
| Planner "‹ Week ›" / Today | Change `from`/`to` (dates in `range.timezone`). |
| Export | `GET /planner/export?from=&to=` → save the `.ics` file. |
| Replan / capacity warning | `POST /schedule/replan`. Show `capacity.items[].message` when `capacity.atRisk` is true. |
| **Add & Setup**, Paste Text → Process with AI | `POST /ingest { text }` |
| Upload PDF | `POST /uploads` → multipart upload → `POST /ingest { s3Key }` → poll `GET /documents/{jobId}` |
| Connected Sources card | `GET /sources`. Use `POST /classroom/sync` for Sync, and `GET /classroom/connect` when `DISCONNECTED` or `REAUTH_REQUIRED`. |
| Timetable card "Edit" | `GET /timetable`, `PUT /timetable/slots/{id}`, `DELETE /timetable/slots/{id}`, or the PDF flow in Section 10. |
| Planning Settings | `GET /preferences`, and `PUT /preferences` on Save Settings. The next `GET /dashboard` or `GET /planner` reflects the change. |
