"use client";
import { useSyncExternalStore } from "react";
import { request, errorMessage } from "../lib/api";
import { invalidate } from "../lib/data";
import { createClassroomSync } from "../lib/classroom-sync";

const classroomSync = createClassroomSync(
  () => request("/classroom/sync", "POST"),
  invalidate, // refreshes sources, tasks, dashboard and planner together
  errorMessage,
);

export function useClassroomSync() {
  const state = useSyncExternalStore(
    classroomSync.subscribe,
    classroomSync.getState,
    classroomSync.getState,
  );
  return { ...state, sync: classroomSync.sync };
}
