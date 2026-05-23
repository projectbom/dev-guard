import type { DriftResult, DriftTelemetry } from "@dev-guard/core";
import { fromRoot, readJsonFile, writeTextFile } from "./fs.js";

interface DriftTelemetryStore {
  events: DriftTelemetry[];
  summary: Record<string, number>;
  bySource?: Record<string, number>;
  bySeverity?: Record<string, number>;
  bySubtype?: Record<string, number>;
  rotatedAt?: number;
}

const telemetryPath = ".devguard/drift-telemetry.json";
const maxEvents = 100;
const maxSummaryKeys = 50;

export async function recordDriftTelemetry(
  root: string,
  input: { result: DriftResult; source: string; driftType?: string; subtype?: string }
): Promise<void> {
  if (input.result.severity === "low") {
    return;
  }

  const driftType = input.driftType ?? input.result.reasons[0] ?? "semantic_drift";
  const current = await readJsonFile<DriftTelemetryStore>(fromRoot(root, telemetryPath), { events: [], summary: {} });
  const event: DriftTelemetry = {
    driftType,
    severity: input.result.severity,
    source: input.source,
    timestamp: Date.now(),
    subtype: input.subtype
  };
  const events = [event, ...current.events].slice(0, maxEvents);
  const summary = incrementAndTrim(current.summary, driftType);
  const bySource = incrementAndTrim(current.bySource ?? {}, input.source);
  const bySeverity = incrementAndTrim(current.bySeverity ?? {}, input.result.severity);
  const bySubtype = input.subtype ? incrementAndTrim(current.bySubtype ?? {}, input.subtype) : (current.bySubtype ?? {});

  await writeTextFile(
    fromRoot(root, telemetryPath),
    `${JSON.stringify({ events, summary, bySource, bySeverity, bySubtype, rotatedAt: Date.now() }, null, 2)}\n`
  );
}

export async function summarizeDriftTelemetry(root: string): Promise<string[]> {
  const store = await readJsonFile<DriftTelemetryStore>(fromRoot(root, telemetryPath), { events: [], summary: {} });
  const lines = [
    "Top Drift Sources:",
    ...formatTop(store.summary, "- none"),
    "",
    "Event Sources:",
    ...formatTop(store.bySource ?? {}, "- none"),
    "",
    "Most Unstable Subtypes:",
    ...formatTop(store.bySubtype ?? {}, "- none"),
    "",
    `Stored Events: ${store.events.length}/${maxEvents}`
  ];
  return lines;
}

export async function readDriftTelemetryStats(root: string): Promise<{
  events: number;
  topDrift: string[];
  unstableSubtypes: string[];
}> {
  const store = await readJsonFile<DriftTelemetryStore>(fromRoot(root, telemetryPath), { events: [], summary: {} });
  return {
    events: store.events.length,
    topDrift: formatTop(store.summary, "none"),
    unstableSubtypes: formatTop(store.bySubtype ?? {}, "none")
  };
}

function incrementAndTrim(summary: Record<string, number>, key: string): Record<string, number> {
  const next = { ...summary, [key]: (summary[key] ?? 0) + 1 };
  return Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxSummaryKeys)
  );
}

function formatTop(summary: Record<string, number>, empty: string): string[] {
  const entries = Object.entries(summary)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  if (entries.length === 0) {
    return [empty];
  }
  return entries.map(([type, count]) => `- ${type}: ${count}`);
}
