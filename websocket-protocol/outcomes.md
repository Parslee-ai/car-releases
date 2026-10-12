{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### outcomes

#### `outcomes.scoreboard`
- **Params**: `null`
- **Returns**: the persistent, OUTCOME-DENOMINATED scoreboard folded from the durable outcome ledger (`models_dir/outcome_ledger.jsonl`):
  `{ rows: ScoreboardRow[], total_successes, total_failures, total_inconclusive, total_usd: number | null, total_usd_is_estimate: boolean, overall_usd_per_success: number | null, model_count, receipts }`, where each `ScoreboardRow` is `{ model_id, success_count, fail_count, inconclusive_count, total_input_tokens, total_output_tokens, avg_quality: number | null, avg_latency_ms, success_rate: number | null, tokens_per_success: number | null, usd_per_success: number | null, usd_is_estimate: boolean }`.
- `usd_per_success` (priced spend ÷ successes) is the headline per-model metric — the dollars-per-correct-outcome the "cry once" thesis is legible in; `overall_usd_per_success` is the deployment-wide figure. Values are `null` rather than fabricated: `usd_per_success`/`total_usd` are `null` for unpriced models, `success_rate`/`tokens_per_success` are `null` until something resolves, and `inconclusive_count` (completed-but-unscored receipts) is surfaced so the denominator's coverage is legible. `usd_is_estimate` and `total_usd_is_estimate` are true for prompt-tiered models whose already-aggregated ledger totals can only be priced at the catalog base tier; consumers must label those values as estimates. Rows are sorted cheapest-correct-outcome first.
- Distinct from `models.stats`: that is the **live in-memory** profiles; this reads the **cross-session ledger** (survives restart, de-biased by the pending-sweep) and joins per-model catalog prices. The FFI `outcome_scoreboard()` (NAPI/PyO3) returns this same JSON as a string.

#### `outcomes.resolve_pending`
- **Params**: `{ actionResults: [[traceId, success, confidence, output], ...] }` — flat tuples produced by a `car-reason` session's `ActionOutcome` vector. `traceId` is a string (`""` is treated as "no trace, skip"); `success` is a boolean; `confidence` is a float `[0.0, 1.0]`; `output` is the generated text.
- **Returns**: `{ recorded: number }` — the count of action results the caller passed (NOT the number of pending traces actually resolved — the tracker doesn't surface that yet).
- Symmetric to the in-process `ReasoningInferenceHandle::record_inferred_outcomes` impl. The daemon runs `OutcomeTracker::infer_outcomes_from_action_sequence` to convert the tuples into resolved outcomes, then writes them back under the tracker's write lock. Lets the routing-learning loop survive daemon-routed reasoning sessions instead of silently no-op'ing.
- Closes the follow-up flagged in Parslee-ai/car#189. Older daemons without this method respond with JSON-RPC `-32601`; the CLI's `DaemonInferenceHandle::record_inferred_outcomes` catches that specific code and falls back to its pre-existing soft no-op so a CLI / daemon version skew during a rolling upgrade doesn't crash reasoning sessions.


{% endraw %}
