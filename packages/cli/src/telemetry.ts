import { readDriftTelemetryStats, summarizeDriftTelemetry } from "./drift-telemetry.js";

export async function runTelemetry(root: string): Promise<void> {
  const [summary, stats] = await Promise.all([summarizeDriftTelemetry(root), readDriftTelemetryStats(root)]);

  console.log("dev-guard telemetry");
  console.log("- privacy: stores drift type/severity/source/subtype counts only; no source code or full requirement text");
  console.log("- rotation: latest 100 events retained; aggregate keys capped");
  console.log(`- stored events: ${stats.events}`);
  console.log("");
  console.log(summary.join("\n"));
}
