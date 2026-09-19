"use client";
import { useCallback, useEffect, useState } from "react";
import { request, errorMessage } from "./api";
let revision = 0;
export function invalidate() {
  revision++;
  window.dispatchEvent(new Event("campusflow:refresh"));
}
export function useResource<T>(path: string | null) {
  const [state, setState] = useState<{
    data: T | null;
    error: string;
    loading: boolean;
    path: string | null;
  }>({ data: null, error: "", loading: !!path, path });
  const [version, setVersion] = useState(revision);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    window.addEventListener("campusflow:refresh", refresh);
    return () => window.removeEventListener("campusflow:refresh", refresh);
  }, [refresh]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState((s) => ({
      data: s.path === path ? s.data : null,
      error: "",
      loading: true,
      path,
    }));
    request<T>(path, "GET", undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, error: "", loading: false, path });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            data: null,
            error: errorMessage(error),
            loading: false,
            path,
          });
      });
    return () => controller.abort();
  }, [path, version]);
  return {
    ...state,
    data: state.path === path ? state.data : null,
    loading: !!path && (state.path !== path || state.loading),
    refresh,
  };
}
