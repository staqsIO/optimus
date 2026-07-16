## 10. Cost Tracking

Every LLM invocation is logged with full cost data in `llm_invocations`:

```json
{
  "id": "inv_20260226153020",
  "date": "2026-02-26",
  "agent_id": "orchestrator-eng",
  "model": "claude-sonnet-4-5-20250514",
  "task_id": "TASK-0042",
  "input_tokens": 3200,
  "output_tokens": 1100,
  "cost_usd": 0.014,
  "running_daily_total_usd": 14.38,
  "idempotency_key": "inv_TASK-0042_attempt_1"
}
```

A utility agent sends a daily cost digest to the board via their preferred channel:

```
Cost Report — 2026-02-26

Total spend today: $14.38

By department:
  Engineering:  $8.42  (12 Claude calls, 47 Haiku calls)
  Product:      $3.21  (5 Claude calls, 12 Haiku calls)
  Executive:    $2.75  (4 Claude calls)

By model:
  Claude Opus:    $2.75  (4 calls)
  Claude Sonnet:  $9.19  (17 calls)
  Haiku 4.5:      $2.44  (59 calls)

Budget remaining this month: $485.62 / $500.00

⚠ Engineering tracking 15% over projected daily burn rate.
```
