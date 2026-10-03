// Regression tests for the OpenAI Responses API request-capability rule,
// verified against OpenAI's own "Using GPT-6" migration guide: "When
// reasoning effort is not `none`, remove `temperature`, `top_p`, and
// `top_logprobs`." Parameter-based (keyed off reasoningEffort), not a
// per-model-name allowlist — a non-reasoning model configured without a
// reasoningEffort must keep sending temperature exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOpenAIResponsesRequestBody } from "@dev-guard/core";

test("no reasoningEffort configured: temperature is sent (current gpt-4o-mini-style behavior, unchanged)", () => {
  const body = buildOpenAIResponsesRequestBody({ model: "gpt-4o-mini", prompt: "x", temperature: 0.2, maxTokens: 4000 });
  assert.equal(body.temperature, 0.2);
  assert.equal(body.reasoning, undefined);
});

test("reasoningEffort = 'none': temperature is still sent", () => {
  const body = buildOpenAIResponsesRequestBody({ model: "gpt-6-luna", prompt: "x", temperature: 0.2, reasoningEffort: "none" });
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.reasoning, { effort: "none" });
});

test("reasoningEffort = 'low': temperature is omitted entirely from the request body", () => {
  const body = buildOpenAIResponsesRequestBody({ model: "gpt-6-luna", prompt: "x", temperature: 0.2, reasoningEffort: "low" });
  assert.equal(body.temperature, undefined);
  assert.ok(!("temperature" in JSON.parse(JSON.stringify(body))), "temperature must not survive JSON serialization either");
  assert.deepEqual(body.reasoning, { effort: "low" });
});

test("reasoningEffort = 'medium'/'high'/'xhigh'/'max': temperature is omitted in every active-reasoning tier", () => {
  for (const effort of ["medium", "high", "xhigh", "max"]) {
    const body = buildOpenAIResponsesRequestBody({ model: "gpt-6-luna", prompt: "x", temperature: 0.2, reasoningEffort: effort });
    assert.equal(body.temperature, undefined, `temperature must be omitted for reasoningEffort=${effort}`);
  }
});

test("no temperature configured at all: request body simply has no temperature key, regardless of reasoning", () => {
  const body = buildOpenAIResponsesRequestBody({ model: "gpt-4o-mini", prompt: "x" });
  assert.equal(body.temperature, undefined);
});
