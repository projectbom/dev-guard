import { readTaskTelemetry } from "./task-telemetry.js";
import { devguardPaths } from "./paths.js";
import { readDriftTelemetryStats, summarizeDriftTelemetry } from "./drift-telemetry.js";

const TASK_EVENT_ORDER = ["TASK_PREPARED", "TASK_DONE", "TASK_FOLLOWUP_FINALIZED", "COMPLETION_SIGNAL_RECEIVED", "COMPLETION_IGNORED", "VALIDATION_RECORDED"] as const;

export async function runTelemetry(root: string): Promise<void> {
  const [summary, stats, taskEvents] = await Promise.all([summarizeDriftTelemetry(root), readDriftTelemetryStats(root), readTaskTelemetry(root, 1000)]);

  // Two separate streams live under .devguard: the task stream (prepare /
  // completion / validation events) and the drift stream summarized below.
  // A "0 events" drift summary used to read as "no telemetry at all".
  const counts = new Map<string, number>();
  for (const event of taskEvents) counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
  console.log("dev-guard telemetry");
  console.log(`Task events (${devguardPaths.taskTelemetry}, latest ${taskEvents.length}): ${TASK_EVENT_ORDER.map((type) => `${type}=${counts.get(type) ?? 0}`).join(", ")}`);
  console.log("  Per-task context efficiency: dev-guard dashboard");
  console.log("");
  console.log("Drift telemetry:");
  console.log("- privacy: stores drift type/severity/source/subtype counts only; no source code or full requirement text");
  console.log("- rotation: latest 100 events retained; aggregate keys capped");
  console.log(`- stored events: ${stats.events}`);
  console.log("");
  console.log(summary.join("\n"));
}
