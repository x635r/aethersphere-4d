/**
 * Shared Open-Meteo quota sentinel.
 *
 * Open-Meteo bills one API call per coordinate and enforces a daily cap plus a
 * per-minute burst cap. Both the Stage 1 grid fetcher and the Stage 2 sounding /
 * transect fetchers draw from the same budget, so the counter lives here rather
 * than inside either fetcher.
 */

/** Documented free-tier minute budget; kept conservative on purpose. */
export const MINUTE_BUDGET = 550;

let spentThisMinute = 0;
let minuteWindowStart = Date.now();

/** Daily accounting, for the HUD. */
let spentToday = 0;
let dayStart = startOfUtcDay(Date.now());

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

function roll(): void {
  const now = Date.now();

  if (now - minuteWindowStart > 60_000) {
    minuteWindowStart = now;
    spentThisMinute = 0;
  }

  const today = startOfUtcDay(now);
  if (today !== dayStart) {
    dayStart = today;
    spentToday = 0;
  }
}

export interface QuotaSnapshot {
  spent: number;
  remaining: number;
  resetInMs: number;
  spentToday: number;
}

export function quotaSnapshot(): QuotaSnapshot {
  roll();
  return {
    spent: spentThisMinute,
    remaining: Math.max(0, MINUTE_BUDGET - spentThisMinute),
    resetInMs: Math.max(0, 60_000 - (Date.now() - minuteWindowStart)),
    spentToday,
  };
}

/** True when `count` more coordinate calls fit inside the minute budget. */
export function hasQuotaFor(count: number): boolean {
  roll();
  return count <= MINUTE_BUDGET - spentThisMinute;
}

/** Record that `count` coordinate calls were successfully spent. */
export function noteUpstreamSpend(count: number): void {
  roll();
  spentThisMinute += count;
  spentToday += count;
}

/** Force the minute window open again (used by the manual retry button). */
export function resetMinuteWindow(): void {
  minuteWindowStart = Date.now();
  spentThisMinute = 0;
}
