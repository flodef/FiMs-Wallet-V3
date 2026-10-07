// Pure rule for the once-per-day ballot change: a member may cast freely the
// first time, then change their decision at most once per 24 h. Re-selecting
// the same option is a no-op, not a change.
export const BALLOT_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000

export function ballotChangeRetryAt(
  existing: { optionId: number; updatedAt: Date } | null,
  optionId: number,
  now = Date.now(),
): Date | null {
  if (!existing || existing.optionId === optionId) return null
  const since = now - existing.updatedAt.getTime()
  return since < BALLOT_CHANGE_WINDOW_MS ? new Date(existing.updatedAt.getTime() + BALLOT_CHANGE_WINDOW_MS) : null
}
