# OpenRouter Model Routing Strategy Research

**Date:** 2026-03-30
**Source:** OpenRouter API (`/api/v1/models`) live data
**Purpose:** Cost-optimized model routing for autobot-inbox agent pipeline

---

## 1. Models by Category (Price per Million Tokens: Input / Output)

### Tier A: Reasoning / Planning (Orchestrator, Strategist, Architect roles)

| Model | Input/M | Output/M | Context | Tool Use | Notes |
|-------|---------|----------|---------|----------|-------|
| google/gemini-2.5-pro | $1.25 | $10.00 | 1048k | Yes | Best value frontier reasoning. Massive context. |
| deepseek/deepseek-r1-0528 | $0.45 | $2.15 | 163k | No (reasoning-only) | Strong reasoning, no tool use |
| deepseek/deepseek-r1 | $0.70 | $2.50 | 64k | No | Original R1, smaller context |
| qwen/qwen3-max | $0.78 | $3.90 | 262k | Yes | Strong reasoning + tools |
| anthropic/claude-sonnet-4 | $3.00 | $15.00 | 200k | Yes | Current baseline. Excellent tool use. |
| openai/gpt-4o | $2.50 | $10.00 | 128k | Yes | Strong all-around |
| anthropic/claude-opus-4.6 | $5.00 | $25.00 | 1000k | Yes | Premium. 1M context. |

**Recommendation for Orchestrator/Strategist:** Gemini 2.5 Pro ($1.25/$10) is 2.4x cheaper than Claude Sonnet on input, with 5x larger context. Qwen3 Max ($0.78/$3.90) is even cheaper with 262k context and tool support.

### Tier B: Code Generation (Executor-Coder, PR creation)

| Model | Input/M | Output/M | Context | Tool Use | Notes |
|-------|---------|----------|---------|----------|-------|
| qwen/qwen3-coder | $0.22 | $1.00 | 262k | Yes | Purpose-built for code. Excellent value. |
| qwen/qwen3-coder:free | $0.00 | $0.00 | 262k | Yes | FREE. Rate-limited. |
| qwen/qwen2.5-coder-32b-instruct | $0.66 | $1.00 | 32k | Yes | Proven code quality |
| mistralai/codestral-2508 | $0.30 | $0.90 | 256k | Yes | Mistral's code model |
| mistralai/devstral-small | $0.10 | $0.30 | 131k | Yes | Lightweight code model |
| deepseek/deepseek-chat-v3.1 | $0.15 | $0.75 | 32k | Yes | V3.1 strong at code |
| google/gemini-2.5-flash | $0.30 | $2.50 | 1048k | Yes | Fast, good code, huge context |

**Recommendation for Executor-Coder:** Qwen3 Coder ($0.22/$1.00) with 262k context is the standout. DeepSeek V3.1 ($0.15/$0.75) as fallback. Both have tool support.

### Tier C: Cheap / Fast (Triage, Classification, Simple Tasks)

| Model | Input/M | Output/M | Context | Tool Use | Notes |
|-------|---------|----------|---------|----------|-------|
| meta-llama/llama-3.3-70b-instruct:free | $0.00 | $0.00 | 65k | Yes | FREE. Strong quality for free tier. |
| qwen/qwen3-coder:free | $0.00 | $0.00 | 262k | Yes | FREE |
| meta-llama/llama-3.1-8b-instruct | $0.02 | $0.05 | 16k | Yes | Extremely cheap |
| mistralai/mistral-nemo | $0.02 | $0.04 | 131k | Yes | Cheap + big context |
| mistralai/mistral-small-3.1-24b | $0.03 | $0.11 | 131k | Yes | Great bang-for-buck |
| google/gemini-2.0-flash-lite-001 | $0.07 | $0.30 | 1048k | Yes | Google's cheapest, huge context |
| meta-llama/llama-3.2-3b-instruct | $0.05 | $0.34 | 80k | Limited | Tiny model, very fast |
| openai/gpt-4o-mini | $0.15 | $0.60 | 128k | Yes | Reliable, good tool use |

**Recommendation for Executor-Triage:** Mistral Small 3.1 ($0.03/$0.11) or Gemini 2.0 Flash Lite ($0.07/$0.30). Both support tools and have 131k+ context. Free tier Llama 3.3 70B for non-critical classification.

### Tier D: Mid-Tier (Reviewer, balanced quality/cost)

| Model | Input/M | Output/M | Context | Tool Use | Notes |
|-------|---------|----------|---------|----------|-------|
| deepseek/deepseek-chat-v3.1 | $0.15 | $0.75 | 32k | Yes | Exceptional value |
| deepseek/deepseek-v3.2 | $0.26 | $0.38 | 163k | Yes | Newer, bigger context |
| qwen/qwen-plus | $0.26 | $0.78 | 1000k | Yes | 1M context at mid-tier price |
| google/gemini-2.5-flash | $0.30 | $2.50 | 1048k | Yes | Fast reasoning model |
| meta-llama/llama-3.3-70b-instruct | $0.10 | $0.32 | 131k | Yes | Open-source workhorse |
| qwen/qwen3-235b-a22b | $0.45 | $1.82 | 131k | Yes | MoE, very capable |
| mistralai/mistral-medium-3.1 | $0.40 | $2.00 | 131k | Yes | Solid mid-range |

**Recommendation for Reviewer:** DeepSeek V3.2 ($0.26/$0.38) or Qwen Plus ($0.26/$0.78 with 1M context).

---

## 2. Head-to-Head Comparison: Target Models

### DeepSeek Family

| Model | Input/M | Output/M | Context | Tools | Best For |
|-------|---------|----------|---------|-------|----------|
| deepseek/deepseek-chat-v3.1 | $0.15 | $0.75 | 32k | Yes | General + code, best value |
| deepseek/deepseek-v3.2 | $0.26 | $0.38 | 163k | Yes | Bigger context, low output cost |
| deepseek/deepseek-v3.2-speciale | $0.40 | $1.20 | 163k | Yes | Enhanced V3.2 variant |
| deepseek/deepseek-r1 | $0.70 | $2.50 | 64k | No | Reasoning-only (no tools) |
| deepseek/deepseek-r1-0528 | $0.45 | $2.15 | 163k | No | Newer R1, better context |

### Llama Family

| Model | Input/M | Output/M | Context | Tools | Best For |
|-------|---------|----------|---------|-------|----------|
| llama-3.3-70b-instruct:free | $0.00 | $0.00 | 65k | Yes | Free classification |
| llama-3.3-70b-instruct | $0.10 | $0.32 | 131k | Yes | Mid-tier workhorse |
| llama-3.1-8b-instruct | $0.02 | $0.05 | 16k | Yes | Ultra-cheap simple tasks |
| llama-3.2-3b-instruct:free | $0.00 | $0.00 | 131k | Limited | Free, tiny |
| llama-4-scout | $0.08 | $0.30 | 327k | Yes | Newest, huge context |
| llama-4-maverick | $0.15 | $0.60 | 1048k | Yes | 1M context |

### Mistral Family

| Model | Input/M | Output/M | Context | Tools | Best For |
|-------|---------|----------|---------|-------|----------|
| mistral-small-3.1-24b | $0.03 | $0.11 | 131k | Yes | Cheap + capable |
| mistral-small-3.2-24b | $0.07 | $0.20 | 128k | Yes | Updated small |
| mistral-nemo | $0.02 | $0.04 | 131k | Yes | Cheapest Mistral |
| mistral-medium-3.1 | $0.40 | $2.00 | 131k | Yes | Mid-tier |
| mistral-large-2512 | $0.50 | $1.50 | 262k | Yes | Current large (cheaper than old!) |
| mistral-large (old) | $2.00 | $6.00 | 128k | Yes | Legacy, expensive |
| codestral-2508 | $0.30 | $0.90 | 256k | Yes | Code-specialized |
| devstral-small | $0.10 | $0.30 | 131k | Yes | Lightweight code |

### Qwen Family

| Model | Input/M | Output/M | Context | Tools | Best For |
|-------|---------|----------|---------|-------|----------|
| qwen3-coder:free | $0.00 | $0.00 | 262k | Yes | Free code generation |
| qwen3-coder | $0.22 | $1.00 | 262k | Yes | Best code value |
| qwen3-235b-a22b | $0.45 | $1.82 | 131k | Yes | Flagship MoE |
| qwen-plus | $0.26 | $0.78 | 1000k | Yes | 1M context mid-tier |
| qwen3-max | $0.78 | $3.90 | 262k | Yes | Top reasoning |
| qwen2.5-coder-7b | $0.03 | $0.09 | 32k | Yes | Ultra-cheap code |
| qwq-32b | $0.15 | $0.58 | 131k | Yes | Reasoning-focused |

### Google Gemini

| Model | Input/M | Output/M | Context | Tools | Best For |
|-------|---------|----------|---------|-------|----------|
| gemini-2.0-flash-lite-001 | $0.07 | $0.30 | 1048k | Yes | Cheapest Google |
| gemini-2.0-flash-001 | $0.10 | $0.40 | 1048k | Yes | Fast + cheap |
| gemini-2.5-flash | $0.30 | $2.50 | 1048k | Yes | Reasoning flash |
| gemini-2.5-flash-lite | $0.10 | $0.40 | 1048k | Yes | Lite reasoning |
| gemini-2.5-pro | $1.25 | $10.00 | 1048k | Yes | Frontier + huge context |
| gemini-3.1-pro-preview | $2.00 | $12.00 | 1048k | Yes | Latest frontier |

### Claude (OpenRouter vs Direct Anthropic)

| Model | OR Input/M | OR Output/M | Direct Input/M | Direct Output/M | Markup |
|-------|-----------|------------|----------------|-----------------|--------|
| claude-3-haiku | $0.25 | $1.25 | $0.25 | $1.25 | 0% |
| claude-3.5-haiku | $0.80 | $4.00 | $0.80 | $4.00 | 0% |
| claude-haiku-4.5 | $1.00 | $5.00 | $1.00 | $5.00 | 0% |
| claude-sonnet-4 | $3.00 | $15.00 | $3.00 | $15.00 | 0% |
| claude-sonnet-4.5 | $3.00 | $15.00 | $3.00 | $15.00 | 0% |
| claude-opus-4.6 | $5.00 | $25.00 | $5.00 | $25.00 | 0% |
| claude-opus-4 | $15.00 | $75.00 | $15.00 | $75.00 | 0% |

**Finding:** OpenRouter passes through Anthropic pricing at 0% markup. No cost penalty for routing Claude through OpenRouter.

### GPT-4o Family

| Model | Input/M | Output/M | Context | Tools |
|-------|---------|----------|---------|-------|
| gpt-4o-mini | $0.15 | $0.60 | 128k | Yes |
| gpt-4o | $2.50 | $10.00 | 128k | Yes |

---

## 3. OpenRouter Platform Features

### Model Routing & Fallback
- **Auto-routing:** Send `model: "openrouter/auto"` and OpenRouter picks the best model for your prompt
- **Provider fallback:** If one provider is down, OpenRouter routes to another hosting the same model
- **Provider preferences:** Specify preferred providers via `provider.order` parameter
- **Model fallback chain:** Use `route: "fallback"` with `models: [...]` array to try models in order

### Free Tier (26 models available)
Notable free models with tool support:
- `meta-llama/llama-3.3-70b-instruct:free` (65k context)
- `qwen/qwen3-coder:free` (262k context)
- `qwen/qwen3-next-80b-a3b-instruct:free` (262k context)
- `qwen/qwen3.6-plus-preview:free` (1000k context!)

Free models have rate limits (typically ~10-20 req/min, varies) and may have queue delays.

### Rate Limits
- Based on account credits/tier
- Per-model rate limits available via `per_request_limits` field
- No published universal rate limit -- varies by provider

### API Compatibility
- OpenAI-compatible API (`/api/v1/chat/completions`)
- Drop-in replacement for OpenAI SDK with base URL change
- Supports: tool_choice, tools, response_format, structured_outputs, streaming

---

## 4. Recommended Routing Strategy for autobot-inbox

### Current vs Proposed Agent Model Mapping

| Agent | Current Model | Proposed Model | Input Savings | Output Savings |
|-------|---------------|----------------|---------------|----------------|
| **Orchestrator** | Claude Sonnet ($3/$15) | Gemini 2.5 Pro ($1.25/$10) | **58%** | **33%** |
| **Strategist** | Claude Opus ($5/$25) | Gemini 2.5 Pro ($1.25/$10) | **75%** | **60%** |
| **Executor-Triage** | Haiku ($1/$5) | Mistral Small 3.1 ($0.03/$0.11) | **97%** | **98%** |
| **Executor-Responder** | Haiku ($1/$5) | DeepSeek V3.1 ($0.15/$0.75) | **85%** | **85%** |
| **Reviewer** | Claude Sonnet ($3/$15) | DeepSeek V3.2 ($0.26/$0.38) | **91%** | **97%** |
| **Architect** | Claude Sonnet ($3/$15) | Qwen Plus ($0.26/$0.78) | **91%** | **95%** |
| **Executor-Ticket** | Haiku ($1/$5) | Mistral Small 3.1 ($0.03/$0.11) | **97%** | **98%** |
| **Executor-Coder** | Claude Sonnet ($3/$15) | Qwen3 Coder ($0.22/$1.00) | **93%** | **93%** |

### Fallback Chains (via OpenRouter `route: "fallback"`)

```
Orchestrator:    gemini-2.5-pro → claude-sonnet-4 → qwen3-max
Strategist:      gemini-2.5-pro → claude-sonnet-4.5
Triage:          mistral-small-3.1 → llama-3.3-70b:free → gpt-4o-mini
Responder:       deepseek-v3.1 → qwen-plus → claude-haiku-4.5
Reviewer:        deepseek-v3.2 → gemini-2.5-flash → claude-sonnet-4
Architect:       qwen-plus → gemini-2.5-pro → claude-sonnet-4
Ticket:          mistral-small-3.1 → gpt-4o-mini
Coder:           qwen3-coder → codestral-2508 → claude-sonnet-4
```

### Cost Projection

Assuming current daily volume (~50 emails, ~200 agent invocations):

| Metric | Current (Anthropic direct) | Proposed (OpenRouter mix) | Savings |
|--------|---------------------------|--------------------------|---------|
| Estimated daily cost | ~$8-12 | ~$0.50-1.50 | **85-90%** |
| G1 ceiling headroom | Tight at $20/day | Massive headroom | Enables L2+ autonomy |

### Key Risks & Mitigations

1. **Quality regression on triage/review:** Mitigate with eval suite before switching. Run shadow mode (both models, compare outputs) for 1 week.
2. **Tool use reliability:** DeepSeek R1 does NOT support tools. Only use for pure reasoning. V3.x series supports tools well.
3. **Rate limits on free tier:** Never depend on free tier for production. Use as cost-saver for non-critical tasks only.
4. **Latency:** OpenRouter adds a routing hop. Typically <100ms overhead. DeepSeek/Qwen hosted in China may have higher latency from US.
5. **Provider outages:** Fallback chains handle this. OpenRouter's multi-provider routing is a key advantage.

### Implementation Path

1. Add OpenRouter as an adapter in `src/adapters/` (OpenAI-compatible, minimal code)
2. Update `config/agents.json` to support model routing config per agent
3. Add `OPENROUTER_API_KEY` to env
4. Shadow-test triage agent first (highest volume, lowest risk)
5. Roll out agent-by-agent over 2 weeks with quality monitoring
