"use client";
import { useState } from "react";
import Link from "next/link";
import type { DocumentJob, NoticeResult, TimetableSlot } from "../lib/types";
import { request, uploadFile, errorMessage } from "../lib/api";
import { invalidate } from "../lib/data";
import { ErrorBox, Icon } from "./ui";
export function NoticeInput({
  onTimetable,
}: {
  onTimetable: (
    slots: TimetableSlot[],
    source: { fileName: string; jobId: string },
    warnings: string[],
  ) => void;
}) {
  const [tab, setTab] = useState("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("notice");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<NoticeResult | null>(null);
  const [job, setJob] = useState<{ id: string; fileName: string } | null>(null);
  async function checkJob(id: string, fileName: string) {
    const r = await request<DocumentJob>(`/documents/${id}`);
    if (r.status === "PROCESSING") {
      setStatus("Your PDF is processing. Check its status shortly.");
      return false;
    }
    if (r.status === "FAILED")
      throw new Error(r.error ?? "This PDF could not be processed.");
    if (!r.result) throw new Error("The document returned no result.");
    if (r.kind === "timetable" && "slots" in r.result) {
      onTimetable(
        r.result.slots,
        { fileName, jobId: id },
        r.result.lowConfidenceRows,
      );
      setStatus("Timetable extracted. Review and save the rows below.");
    } else if ("action" in r.result) {
      setResult(r.result);
      setStatus("PDF processed.");
      invalidate();
    }
    setJob(null);
    return true;
  }
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (tab === "text") {
        setStatus("Reading your notice…");
        const r = await request<NoticeResult>("/ingest", "POST", {
          text: text.trim(),
        });
        setResult(r);
        if (r.action !== "IGNORE" && r.action !== "REVIEW") setText("");
        invalidate();
        setStatus("");
      } else {
        if (!file) throw new Error("Choose a PDF first.");
        if (
          file.size > 10 * 1024 * 1024 ||
          !file.name.toLowerCase().endsWith(".pdf")
        )
          throw new Error("Choose a PDF no larger than 10 MB.");
        setStatus("Uploading PDF…");
        const upload = await request<{
          url: string;
          fields: Record<string, string>;
          s3Key: string;
        }>("/uploads", "POST", {
          fileName: file.name,
          contentType: "application/pdf",
          size: file.size,
        });
        await uploadFile(upload, file);
        setStatus("Starting document processing…");
        const started = await request<DocumentJob>(
          kind === "notice" ? "/ingest" : "/timetable",
          "POST",
          { s3Key: upload.s3Key },
        );
        setJob({ id: started.jobId, fileName: file.name });
        for (let i = 0; i < 15; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (await checkJob(started.jobId, file.name)) break;
        }
      }
    } catch (e) {
      setError(errorMessage(e));
      setStatus("");
      invalidate();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card quiet-card">
      <h2>Add a Notice or PDF</h2>
      <div className="segmented">
        <button
          aria-pressed={tab === "text"}
          disabled={busy}
          className={tab === "text" ? "selected" : ""}
          onClick={() => setTab("text")}
        >
          <Icon name="edit" size={15} />
          Paste Text
        </button>
        <button
          aria-pressed={tab === "pdf"}
          disabled={busy}
          className={tab === "pdf" ? "selected" : ""}
          onClick={() => setTab("pdf")}
        >
          <Icon name="upload" size={15} />
          Upload PDF
        </button>
      </div>
      <ErrorBox message={error} />
      {tab === "text" ? (
        <label>
          <span className="sr-only">Academic notice</span>
          <textarea
            className="notice-text"
            rows={5}
            maxLength={12000}
            placeholder="Paste announcements, syllabus updates, or any academic notice here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
        </label>
      ) : (
        <div className="form-stack">
          <label>
            Document type
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="notice">Academic notice</option>
              <option value="timetable">Class timetable</option>
            </select>
          </label>
          <label className="upload-area">
            <Icon name="upload" size={24} />
            <strong>{file?.name ?? "Choose a PDF document"}</strong>
            <span className="muted tiny">
              Up to 10 MB · Timetables require review
            </span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      )}
      <div className="button-row between notice-action">
        <span className="tiny muted" role="status">
          {busy
            ? status
            : tab === "text"
              ? `${text.length.toLocaleString()} / 12,000`
              : status}
        </span>
        <button
          className="button focus"
          disabled={busy || (tab === "text" ? !text.trim() : !file) || !!job}
          onClick={() => void submit()}
        >
          {busy ? "Processing…" : "Process with AI"}
        </button>
      </div>
      {job && !busy && (
        <button
          className="button secondary small"
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await checkJob(job.id, job.fileName);
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Check PDF status
        </button>
      )}
      {result && (
        <div className="message success" role="status">
          <strong>
            {
              {
                CREATE: "Task created",
                UPDATE: "Task updated",
                CANCEL: "Task cancelled",
                IGNORE: "No change made",
                REVIEW: "Needs your review",
              }[result.action]
            }
          </strong>
          <p>{result.changeSummary}</p>
          {(result.taskId || result.event?.eventId) && (
            <Link
              href={`/tasks?task=${result.taskId ?? result.event?.eventId}`}
            >
              Open Task →
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
