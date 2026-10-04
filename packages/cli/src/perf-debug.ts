// TEMPORARY diagnostic instrumentation for the end-to-end performance
// investigation. Gated entirely behind DEV_GUARD_PERF_DEBUG so normal CLI
// output is never touched. Records are buffered in memory and flushed in
// ONE batch (perfFlush) rather than logged as they happen — logging
// per-event was itself distorting the measurement (a slow synchronous
// console.error on a near-full/degraded disk could delay the `finally`
// block's return without that delay showing up in the reported duration,
// since the duration string is computed before the log call). Candidate
// for removal once the hot paths are understood and fixed.
const enabled = process.env.DEV_GUARD_PERF_DEBUG === "1";
const records: Array<{ label: string; t: number; durationMs?: number }> = [];

export function perfEnabled(): boolean {
  return enabled;
}

export async function perfSpan<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    records.push({ label, t: start, durationMs: performance.now() - start });
  }
}

export function perfMark(label: string): void {
  if (!enabled) return;
  records.push({ label, t: performance.now() });
}

export function perfFlush(): void {
  if (!enabled || records.length === 0) return;
  const base = records[0].t;
  for (const r of records) {
    const rel = (r.t - base).toFixed(1);
    console.error(r.durationMs === undefined ? `[perf-debug] mark ${r.label} @ ${rel}ms` : `[perf-debug] ${r.label}: ${r.durationMs.toFixed(1)}ms (started @ ${rel}ms)`);
  }
  records.length = 0;
}
