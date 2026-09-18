"use client";

import { useCallback, useState } from "react";
import NoticeWorkspace from "./notice-workspace";
import TimelinePanel from "./timeline-panel";
import SetupPanel from "./setup-panel";

export default function Workspace() {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return <><TimelinePanel revision={revision} /><NoticeWorkspace revision={revision} onChange={refresh} /><SetupPanel onChange={refresh} /></>;
}
