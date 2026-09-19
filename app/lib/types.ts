export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type TaskStatus = "OPEN" | "COMPLETED" | "CANCELLED";
export type TaskType =
  "EXAM" | "ASSIGNMENT" | "LAB" | "LECTURE" | "ADMIN" | "CLUB" | "OTHER";
export type PriorityReason =
  | "OVERDUE"
  | "DUE_WITHIN_48_HOURS"
  | "EXAM_WITHIN_4_DAYS"
  | "HIGH_WORKLOAD_PRESSURE"
  | "MODERATE_WORKLOAD_PRESSURE"
  | "DUE_WITHIN_7_DAYS"
  | "DUE_LATER"
  | "NO_DEADLINE";
export type BlockType = "STUDY" | "CLASS" | "LAB" | "EVENT" | "OTHER";
export type SyncStatus =
  | "NEVER_SYNCED"
  | "SYNCING"
  | "SUCCESS"
  | "PARTIAL"
  | "ERROR"
  | "REAUTH_REQUIRED";
export type SourceHealth =
  | "DISCONNECTED"
  | "NEVER_SYNCED"
  | "SYNCING"
  | "HEALTHY"
  | "STALE"
  | "ERROR"
  | "REAUTH_REQUIRED";
export type Profile = {
  name: string;
  program: string;
  year: string;
  section: string;
  semester: string | null;
  semesterStartDate: string | null;
  timezone: string;
  academicWeek: number | null;
  connectedCourses: string[];
  timetableSlots: TimetableSlot[];
};
export type Sources = {
  classroom: {
    connection: "CONNECTED" | "DISCONNECTED";
    health: SourceHealth;
    account: { email: string | null; name: string | null } | null;
    selectedCourses: {
      id: string;
      name: string | null;
      lastSyncedAt: string | null;
    }[];
    sync: {
      status: SyncStatus;
      trigger: "scheduled" | "manual" | null;
      stale: boolean;
      lastAttemptAt: string | null;
      lastFinishedAt: string | null;
      lastSuccessfulSyncAt: string | null;
      lastErrorCode: string | null;
      lastResult: SyncResult | null;
    };
  };
  timetable: {
    status: "READY" | "NOT_IMPORTED";
    slotCount: number;
    source: TimetableSource | null;
  };
};
export type Dashboard = {
  profile: Pick<
    Profile,
    "name" | "program" | "year" | "section" | "semester" | "academicWeek"
  >;
  date: { now: string; today: string; weekday: string; timezone: string };
  summary: {
    tasksToday: number;
    highPriority: number;
    highPriorityOpen: number;
    overdue: number;
    plannedStudyMinutes: number;
    completedToday: number;
  };
  nextClass: {
    title: string;
    classType: string;
    type: "CLASS" | "LAB";
    start: string;
    end: string;
    location: string | null;
    inProgress: boolean;
  } | null;
  priorities: (TaskListItem & { dueToday: boolean; scheduledToday: boolean })[];
  completedToday: TaskListItem[];
  todaySchedule: {
    id: string;
    kind: BlockType;
    title: string;
    classType: string | null;
    start: string;
    end: string;
    location: string | null;
    taskId: string | null;
    isPast: boolean;
    isCurrent: boolean;
    isNext: boolean;
  }[];
  capacity: Capacity | null;
  sync: {
    classroom: {
      connection: "CONNECTED" | "DISCONNECTED";
      health: SourceHealth;
      status: SyncStatus;
      lastSuccessfulSyncAt: string | null;
    };
  };
};
export type Planner = {
  range: { from: string; to: string; timezone: string };
  classes: ClassOccurrence[];
  blocks: ScheduleBlock[];
  deadlines: {
    taskId: string;
    title: string;
    type: TaskType;
    course: Course | null;
    deadline: string;
    status: TaskStatus;
  }[];
  capacity: Capacity | null;
  planning: { lastPlannedAt: string | null; autoScheduleStudyBlocks: boolean };
};
export type TaskList = {
  tasks: TaskListItem[];
  counts: {
    all: number;
    upcoming: number;
    highPriority: number;
    completed: number;
    cancelled: number;
  };
};
export type TaskInput = {
  title?: string;
  courseName?: string | null;
  type?: TaskType;
  deadline?: string | null;
  estimatedMinutes?: number | null;
  manualPriorityOverride?: Priority | null;
  notes?: string;
};
export type NoticeResult = {
  action: "CREATE" | "UPDATE" | "CANCEL" | "IGNORE";
  changeSummary: string;
  taskId?: string;
  event: { eventId: string } | null;
};
export type DocumentJob = {
  jobId: string;
  kind: "notice" | "timetable";
  status: "PROCESSING" | "SUCCEEDED" | "FAILED";
  result?:
    NoticeResult | { slots: TimetableSlot[]; lowConfidenceRows: string[] };
  error?: string;
};

export type ISODateTime = string; // "2026-09-21T13:30:00.000Z"
export type ISODate = string; // "2026-09-21"
export type ClockTime = string; // "18:00"

export type Course = { id: string | null; name: string | null };

// Returned by list views and embedded in the dashboard.
export type TaskListItem = {
  id: string;
  academicEventId: string | null; // set when the task comes from a source
  isSourceBacked: boolean; // true: title/course/type/deadline are read-only
  source: "CLASSROOM" | "MANUAL_NOTICE" | "PDF" | "MANUAL";
  sourceRef: string | null; // Classroom: "<courseId>:<kind>:<itemId>"
  sourceStatus: "ACTIVE" | "CANCELLED" | "DONE" | null; // the source's own status
  title: string;
  course: Course | null;
  type: TaskType;
  deadline: ISODateTime | null;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  completedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;
  isOverdue: boolean; // OPEN and past its deadline
  calculatedPriority: Priority | null; // null unless OPEN
  priorityReason: PriorityReason | null;
  manualPriorityOverride: Priority | null;
  effectivePriority: Priority | null; // override ?? calculated; null unless OPEN
  estimatedMinutes: number | null; // effective estimate; null = unknown
  estimateSource: "STUDENT" | "SOURCE" | "AI" | null;
  actualMinutes: number; // focus minutes logged
  remainingMinutes: number | null; // max(0, estimate − actual); null if unknown
  progress: {
    timePercent: number | null; // actual/estimate, 0–100; null if no estimate
    actualMinutes: number;
    estimatedMinutes: number | null;
  };
  checklistProgress: { done: number; total: number; percent: number | null }; // null when empty
  bookmarked: boolean;
  attachmentCount: number; // READY attachments only
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  version: number; // informational
};

// Returned by single-task routes.
export type TaskDetail = TaskListItem & {
  studentEstimatedMinutes: number | null;
  sourceEstimatedMinutes: number | null;
  aiEstimate: {
    estimatedMinutes: number;
    workUnits: { title: string; minutes: number }[]; // advisory steps, 1–8
    rationale: string;
    model: string | null; // "openai/gpt-oss-120b"
    generatedAt: ISODateTime;
  } | null;
  notes: string; // plain text / simple markdown
  checklist: ChecklistItem[]; // in display order
  attachments: Attachment[];
};

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt: ISODateTime;
  completedAt: ISODateTime | null;
};

export type Attachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number; // bytes
  status: "PENDING" | "READY";
  createdAt: ISODateTime;
};

export type FocusSession = {
  id: string;
  taskId: string;
  taskTitle: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  plannedMinutes: number; // default 25
  startedAt: ISODateTime;
  pausedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  cancelledAt: ISODateTime | null;
  completedMinutes: number | null; // minutes credited to the task
  elapsedSeconds: number; // server-measured focus time, excluding pauses
  isRunning: boolean; // status === "ACTIVE"
};

export type ScheduleBlock = {
  id: string;
  taskId: string | null;
  type: BlockType;
  title: string;
  start: ISODateTime;
  end: ISODateTime;
  generated: boolean; // true = created by the planner
  status: "PLANNED";
  isPast: boolean; // end <= now
  outsidePreferredWindow: boolean; // placed outside the preferred window to fit a deadline
  location: string | null;
};

export type ClassOccurrence = {
  id: string; // "class:<slotId>:<date>"
  slotId: string | null;
  date: ISODate;
  type: "CLASS" | "LAB";
  classType: "Lecture" | "Lab" | "Tutorial";
  title: string; // subject
  start: ISODateTime;
  end: ISODateTime;
  location: string | null; // room
};

export type Capacity = {
  atRisk: boolean; // true when any item cannot fit
  totalUnscheduledMinutes: number;
  items: {
    taskId: string;
    title: string;
    deadline: ISODateTime | null;
    requiredMinutes: number;
    scheduledMinutes: number;
    unscheduledMinutes: number;
    reason: "INSUFFICIENT_CAPACITY" | "DEADLINE_PASSED";
    message: string; // e.g. "3 h 10 min of DBMS Assignment cannot fit before Wed 23 Sept, 23:59."
  }[];
  unestimatedTasks: {
    taskId: string;
    title: string;
    deadline: ISODateTime | null;
  }[]; // cannot be planned until sized
  deferred: {
    taskId: string;
    title: string;
    deadline: ISODateTime | null;
    unscheduledMinutes: number;
  }[]; // due beyond the 14-day horizon
};

export type TimetableSlot = {
  id: string;
  day:
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday"
    | "Sunday";
  startTime: ClockTime;
  endTime: ClockTime;
  subject: string;
  type: "Lecture" | "Lab" | "Tutorial";
  room: string; // may be ""
};

export type TimetableSource = {
  kind: "PDF" | "MANUAL";
  fileName: string | null;
  jobId: string | null;
  importedAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type Preferences = {
  dailyStudyHours: number; // 1–12, in steps of 0.25
  preferredStudyStart: ClockTime; // must be before preferredStudyEnd
  preferredStudyEnd: ClockTime;
  autoScheduleStudyBlocks: boolean;
  avoidClassConflicts: boolean;
  timezone: string; // IANA, e.g. "Asia/Kolkata"
};

export type SyncResult = {
  coursesScanned: number;
  announcementsScanned: number;
  courseworkScanned: number;
  processed: number;
  created: number;
  updated: number;
  cancelled: number;
  ignored: number;
  failed: number;
  truncated: boolean; // stopped at the time budget; the rest resumes next run
};

export type ClassroomSyncStatus = {
  status: "SYNCING" | "SUCCESS" | "PARTIAL" | "ERROR" | "REAUTH_REQUIRED";
  trigger: "scheduled" | "manual";
  lastAttemptAt: ISODateTime;
  lastFinishedAt: ISODateTime | null;
  lastSuccessfulSyncAt: ISODateTime | null;
  lastErrorCode: string | null; // e.g. REAUTH_REQUIRED, GOOGLE_CLIENT_CONFIG, CLASSROOM_ACCESS_DENIED, SYNC_FAILED
  lastResult: SyncResult | null;
};
