// Liveness only: this does not claim that AWS or Google access is configured.
export async function handler() {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ status: "ok", service: "campusflow" }),
  };
}
