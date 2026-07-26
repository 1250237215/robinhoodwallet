export const POST_UPLOAD_RETRY_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000]);

export function postUploadRetryDelay(attempt) {
  const index = Number(attempt);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return POST_UPLOAD_RETRY_DELAYS_MS[index] ?? null;
}
