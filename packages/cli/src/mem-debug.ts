// TEMPORARY diagnostic instrumentation for the PartnerFlow OOM
// investigation. Gated entirely behind DEV_GUARD_MEM_DEBUG so normal
// `dev-guard watch` output is never touched. Writes to stderr (sync-ish via
// console.error) so data survives up to the moment of an OOM crash.
// Candidate for removal once the root cause is fixed and confirmed.
const enabled = process.env.DEV_GUARD_MEM_DEBUG === "1";

const readCounts = new Map<string, { count: number; totalBytes: number }>();

export function memDebugEnabled(): boolean {
  return enabled;
}

export function recordFileRead(path: string, bytes: number): void {
  if (!enabled) return;
  const entry = readCounts.get(path) ?? { count: 0, totalBytes: 0 };
  entry.count += 1;
  entry.totalBytes += bytes;
  readCounts.set(path, entry);
}

export function logMemSnapshot(label: string, extra: Record<string, unknown> = {}): void {
  if (!enabled) return;
  const mem = process.memoryUsage();
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
  console.error(
    `[mem-debug] ${label} t=${new Date().toISOString()} rss=${mb(mem.rss)} heapUsed=${mb(mem.heapUsed)} heapTotal=${mb(mem.heapTotal)} external=${mb(mem.external)} arrayBuffers=${mb(mem.arrayBuffers)} ${JSON.stringify(extra)}`
  );
}

export function logTopReads(limit = 15): void {
  if (!enabled) return;
  const sorted = [...readCounts.entries()].sort((a, b) => b[1].totalBytes - a[1].totalBytes).slice(0, limit);
  console.error("[mem-debug] top file reads by total bytes:");
  for (const [path, { count, totalBytes }] of sorted) {
    console.error(`[mem-debug]   ${(totalBytes / (1024 * 1024)).toFixed(2)}MB total, ${count}x, avg ${(totalBytes / count / 1024).toFixed(1)}KB — ${path}`);
  }
}
