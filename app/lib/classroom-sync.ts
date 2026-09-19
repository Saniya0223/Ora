// One Classroom sync controller shared by every "Sync now" button, so the
// sidebar and the Connected Sources card cannot diverge or double-submit.
export type ClassroomSyncState = { syncing: boolean; error: string };

export function createClassroomSync(
  post: () => Promise<unknown>,
  refresh: () => void,
  describeError: (error: unknown) => string,
) {
  let state: ClassroomSyncState = { syncing: false, error: "" };
  const listeners = new Set<() => void>();
  const set = (next: ClassroomSyncState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Resolves true when the sync request succeeded; a click while a sync is
    // already running is ignored rather than sent twice.
    async sync(): Promise<boolean> {
      if (state.syncing) return false;
      set({ syncing: true, error: "" });
      let ok = false;
      try {
        await post();
        ok = true;
        set({ syncing: false, error: "" });
      } catch (error) {
        set({ syncing: false, error: describeError(error) });
      }
      refresh();
      return ok;
    },
  };
}
