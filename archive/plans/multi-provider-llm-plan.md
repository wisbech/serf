# Multi-Provider LLM Infrastructure Plan

## Problem

Current serf uses a single LLM backend (ollama or anthropic) with a simple budget tracker that only tracks token counts. Users hit provider rate limits and have no fallback. No per-agent provider configuration.

## Goal

- Per-agent provider configuration (actor uses one provider, critic another)
- Multiple providers simultaneously (ollama + anthropic + openai + google + groq + etc.)
- Automatic failover when a provider hits rate limits
- Budget tracks: tokens + provider rate-limit remaining + cost per provider
- Seamless switching — the agent doesn't know or care which provider answers
- **Per-project config** (not global — each serf project has its own provider setup)
- **Local-first for trivial tasks**, but actor/critic need more intelligence/speed
- **Priority editable interactively** — `serf start` helps the user set this up via prompt

## Current State (llm.ts)

- Single `backend` config: "ollama" | "anthropic"
- Single `BudgetTracker`: token count + dollar cost
- `callLLM` hardcodes provider logic

## Plan

### 1. Provider Abstraction (llm.ts)

```typescript
```typescript
interface LLMProvider {
  name: string;
  call(prompt: string, options: CallLLMOptions): Promise<CallLLMResult>;
  getRateLimit(): Promise<RateLimitInfo>; // remaining requests, reset time
  estimateCost(tokens: number): number;
}

const providers = new Map<string, LLMProvider>();
```

Built-in: `OllamaProvider`, `AnthropicProvider`, `OpenAIProvider`, `GoogleProvider`, `GroqProvider`, `OpenRouterProvider`.

### 2. Provider Registry & Selection

```typescript
// .serf/config.json (per-project)
{
  "providers": {
    "ollama": { "enabled": true, "baseUrl": "http://localhost:11434" },
    "anthropic": { "enabled": true, "apiKey": "..." },
    "openrouter": { "enabled": true, "apiKey": "..." }
  },
  "agents": {
    "actor": { 
      "provider": "anthropic", 
      "model": "claude-sonnet-4", 
      "fallback": ["openrouter", "ollama"],
      "priority": "intelligence"  // "cost" | "speed" | "intelligence" | "local"
    },
    "critic": { 
      "provider": "openrouter", 
      "model": "gpt-4o", 
      "fallback": ["anthropic", "ollama"],
      "priority": "intelligence"
    },
    "spawned": {  // default for spawned serfs
      "provider": "ollama",
      "model": "llama3",
      "fallback": ["anthropic"],
      "priority": "cost"
    }
  }
}
```

### 3. Smart Router with Priority + Failover

```typescript
async function callLLM(prompt, options) {
  const agentName = options.agent || "actor";
  const agentConfig = getAgentConfig(agentName);
  
  // Build ordered provider list based on priority
  const providersInOrder = buildProviderOrder(agentConfig);
  
  for (const providerName of providersInOrder) {
    const provider = providers.get(providerName);
    if (!provider?.enabled) continue;
    
    const limit = await provider.getRateLimit();
    if (limit.remaining === 0) continue;
    
    try {
      return await provider.call(prompt, options);
    } catch (e) {
      if (isRateLimitError(e)) {
        provider.markExhausted();
        continue;
      }
      throw e;
    }
  }
  throw new Error("All providers exhausted");
}

function buildProviderOrder(config: AgentConfig): string[] {
  // Primary provider first, then fallbacks ordered by priority match
  const primary = config.provider;
  const fallbacks = config.fallback.sort((a, b) => 
    priorityScore(b, config.priority) - priorityScore(a, config.priority)
  );
  return [primary, ...fallbacks];
}
```

### 4. Enhanced Budget Tracker

```typescript
interface ProviderBudget {
  provider: string;
  tokensUsed: number;
  requestsUsed: number;
  costUSD: number;
  rateLimit: { remaining: number; resetAt: Date };
}

class BudgetTracker {
  perProvider: Map<string, ProviderBudget>;
  projectTokenLimit: number;
  projectCostLimit: number;
  
  canAfford(provider: string, estimatedTokens: number): boolean;
  record(provider: string, tokens: number, cost: number, rateLimitInfo);
  getRemaining(provider: string): { tokens: number; requests: number; cost: number };
}
```

### 5. CLI for Provider Management

```bash
serf provider list          # list configured providers + status
serf provider add openrouter --key $KEY
serf provider enable anthropic
serf provider disable ollama
serf provider status        # shows rate limits, budget per provider
serf budget                   # shows per-provider + project budget
```

### 6. Interactive Setup on `serf start`

On first run (or when `.serf/config.json` missing provider config), `serf start` launches the coding agent with a **provider setup prompt**:

> "I'm setting up LLM providers for this project. Let me check what's available...
> 
> **Providers detected on your system:**
> - ollama (local, free, unlimited) - models: llama3, codellama
> - anthropic (API key required) - models: claude-sonnet-4, opus
> - openrouter (API key required) - models: gpt-4o, llama3, mixtral
> - groq (API key required) - free tier available
> 
> **Recommended setup for this project:**
> - **actor** (executes tasks): anthropic/claude-sonnet-4 for intelligence
> - **critic** (evaluates): openrouter/gpt-4o for intelligence + fallback
> - **spawned serfs** (trivial tasks): ollama/llama3 for cost efficiency
> 
> Do you want to:
> 1. **Accept defaults** (anthropic actor, openrouter critic, ollama spawned)
> 2. **Customize** — I'll walk you through each role
> 3. **Local-only** — use ollama for everything
> 
> Your choice:"

The agent writes the config to `.serf/config.json` and the user never edits JSON manually.

### 7. Provider Health Dashboard (`serf provider status`)

```
Providers:
  anthropic    ●●●○○  45 req/min remaining  | $0.42 / $5.00  | claude-sonnet-4
  openrouter   ●●●●○  1,200 req/day left   | $0.18 / $2.00  | gpt-4o, llama3
  ollama       ●●●●●  local, unlimited      | $0.00          | llama3, codellama
  groq         ●●●●●  30 req/sec            | $0.00          | mixtral, llama3
  
Actor  → anthropic (fallback: openrouter, ollama)  [priority: intelligence]
Critic → openrouter (fallback: anthropic, ollama)  [priority: intelligence]
Spawned → ollama (fallback: anthropic)             [priority: cost]
```

## Implementation Phases

1. **Provider abstraction + registry** (llm.ts refactor)
2. **Per-project config schema** (.serf/config.json with providers + agents)
3. **Router with priority + failover** (buildProviderOrder, rate-limit skip)
4. **Enhanced BudgetTracker** (per-provider tokens, requests, cost, rate limits)
5. **Interactive setup prompt** (in `buildMasterPrompt` or separate)
6. **CLI commands** (provider add/enable/disable/status, budget)
8. **Rate limit detection** per provider (parse headers, track resets)
9. **Health dashboard** (`serf provider status`)

## Questions for Discussion

1. **Spawned serfs** — are they still a thing? If yes, they get their own provider config (default: ollama for cost). If no, remove from config.

2. **Priority values** — "cost" | "speed" | "intelligence" | "local" — are these the right four? Or just "local-first" vs "cloud-best"?

3. **Spawned serfs fallback** — should they fall back to cloud at all? Or just fail fast on local?

4. **Cost tracking** — OpenRouter pricing varies by model. Track per-model cost estimates? Or just per-provider?

5. **Rate limit parsing** — Each provider has different headers. Normalize to common `RateLimitInfo`.

6. **Failover transparency** — Log in events, don't tell the agent. The agent just sees "call succeeded."

7. **Config migration** — What happens when user runs `serf start` on an old project without provider config? (Auto-prompt setup)

8. **Detected providers** — `serf init` could detect API keys in env and pre-fill config. Or the master agent prompts for keys on first setup.