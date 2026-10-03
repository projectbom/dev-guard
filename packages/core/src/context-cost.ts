/**
 * Provider-independent context cost estimation.
 *
 * DevGuard has no access to any AI provider's real token counts or context
 * window usage. Everything here is a local, approximate heuristic used only
 * to compare DevGuard's own generated artifacts against each other (e.g.
 * "is the resume bundle for this task bigger than last time", "which
 * artifact dominates the resume cost") — never to predict or report actual
 * provider billing/usage. Callers must keep presenting these numbers as
 * estimates, not measurements.
 */

/**
 * Rough chars-per-token ratio for English-dominant text. Mixed-script text
 * (e.g. Korean, which DevGuard's own renderers produce in ko-KR locale)
 * tokenizes denser than this per character, so this estimate is a
 * conservative, provider-agnostic approximation — not a stand-in for any
 * specific tokenizer.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface ArtifactCostMetrics {
  label: string;
  bytes: number;
  lines: number;
  /** Approximate — see module doc. Never a provider-billed token count. */
  estimatedTokens: number;
}

/**
 * Approximate token count for a chunk of text. Deliberately simple
 * (character-count based) so it stays provider-independent instead of
 * chasing any one vendor's tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function measureArtifactText(label: string, text: string): ArtifactCostMetrics {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  return { label, bytes, lines, estimatedTokens: estimateTokens(text) };
}

export interface ArtifactCostSummary {
  items: ArtifactCostMetrics[];
  totalBytes: number;
  totalLines: number;
  /** Approximate — see module doc. */
  totalEstimatedTokens: number;
}

export function summarizeArtifactCosts(items: ArtifactCostMetrics[]): ArtifactCostSummary {
  return {
    items,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    totalLines: items.reduce((sum, item) => sum + item.lines, 0),
    totalEstimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0)
  };
}
