export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details: { field: string; issue: string }[] = [],
  ) {
    super(message);
  }
}
export function apiBase() {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await (await response(path, method, body, signal)).json()) as T;
}
async function response(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
) {
  if (!apiBase())
    throw new ApiError(
      "NOT_CONFIGURED",
      "The academic service is not configured.",
    );
  let result: Response;
  const timeout = AbortSignal.timeout(90_000);
  try {
    result = await fetch(`${apiBase()}${path}`, {
      method,
      cache: "no-store",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted)
      throw new ApiError(
        "TIMEOUT",
        "The request took too long. Refresh before retrying; your changes may already have been saved.",
      );
    throw new ApiError(
      "NETWORK_ERROR",
      "Cannot reach CampusFlow. Check your connection and try again.",
    );
  }
  if (!result.ok) {
    const data = await result.json().catch(() => ({}));
    throw new ApiError(
      data.error?.code ?? "REQUEST_FAILED",
      data.error?.message ??
        "This request could not be completed. Please try again.",
      result.status,
      data.error?.details ?? [],
    );
  }
  return result;
}
export async function downloadCalendar(path: string, filename: string) {
  const result = await response(path);
  const blob = await result.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function uploadFile(
  upload: { url: string; fields: Record<string, string> },
  file: File,
) {
  const data = new FormData();
  Object.entries(upload.fields).forEach(([key, value]) =>
    data.append(key, value),
  );
  const pdfBlob = new Blob([file], { type: "application/pdf" });
  data.append("file", pdfBlob, file.name);
  let result: Response;
  try {
    result = await fetch(upload.url, { method: "POST", body: data });
  } catch {
    throw new ApiError(
      "UPLOAD_FAILED",
      "The file could not reach storage. Check your connection and retry.",
    );
  }
  if (!result.ok)
    throw new ApiError(
      "UPLOAD_FAILED",
      "The file upload failed. Please retry.",
    );
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
