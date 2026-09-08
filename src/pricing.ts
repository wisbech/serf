import type { Config } from "./state";

// Per-million-token pricing, from public model pricing pages. Serf uses these
// to compute REAL dollar cost per call, instead of a flat cost-per-token guess.
// Local models (no "/" and running on your own hardware) cost ~0 — the only
// "cost" is time.
//
// Keys are model names as they appear in the call (provider prefix stripped,
// e.g. "glm-5.3-flash:cloud" → "glm-5.3-flash:cloud" key below).
// Override/extend via Config.modelCosts in .serf/config.json.
export interface ModelPrice {
  inputPerM: number;   // $ per million input tokens
  outputPerM: number;  // $ per million output tokens
  source?: "ollama-cloud" | "openrouter" | "custom";
}

// Seeded from ollama.com/pricing (cloud). Prices are per million tokens.
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "deepseek-v4-flash:cloud": { inputPerM: 0.22, outputPerM: 0.66, source: "ollama-cloud" },
  "deepseek-v4-pro:cloud": { inputPerM: 0.66, outputPerM: 1.98, source: "ollama-cloud" },
  "gemma4:cloud": { inputPerM: 0.14, outputPerM: 0.40, source: "ollama-cloud" },
  "glm-5.3:cloud": { inputPerM: 1.40, outputPerM: 4.40, source: "ollama-cloud" },
  "glm-5.3-flash:cloud": { inputPerM: 0.15, outputPerM: 0.50, source: "ollama-cloud" },
  "glm-5.2:cloud": { inputPerM: 1.40, outputPerM: 4.40, source: "ollama-cloud" },
  "glm-5.1:cloud": { inputPerM: 1.00, outputPerM: 3.20, source: "ollama-cloud" },
  "gpt-oss:120b": { inputPerM: 0.15, outputPerM: 0.60, source: "ollama-cloud" },
  "gpt-oss:20b": { inputPerM: 0.07, outputPerM: 0.30, source: "ollama-cloud" },
  "kimi-k3:cloud": { inputPerM: 3.00, outputPerM: 15.00, source: "ollama-cloud" },
  "kimi-k2.7-code:cloud": { inputPerM: 0.95, outputPerM: 4.00, source: "ollama-cloud" },
  "kimi-k2.6:cloud": { inputPerM: 0.95, outputPerM: 4.00, source: "ollama-cloud" },
  "minimax-m3:cloud": { inputPerM: 0.60, outputPerM: 2.40, source: "ollama-cloud" },
  "minimax-m2.7:cloud": { inputPerM: 0.30, outputPerM: 1.20, source: "ollama-cloud" },
  "mistral-large-3": { inputPerM: 0.50, outputPerM: 1.50, source: "ollama-cloud" },
  "nemotron-3-nano:4b": { inputPerM: 0.06, outputPerM: 0.24, source: "ollama-cloud" },
  "nemotron-3-super": { inputPerM: 0.015, outputPerM: 0.60, source: "ollama-cloud" },
  "nemotron-3-ultra": { inputPerM: 0.10, outputPerM: 3.00, source: "ollama-cloud" },
  "qwen3.5:397b": { inputPerM: 0.60, outputPerM: 3.60, source: "ollama-cloud" },
};

// Look up pricing for a model name. Local models (running on your own machine)
// cost $0 — the only cost is time. Falls back to a conservative default.
export function modelPrice(model: string, config?: Config): ModelPrice {
  const overrides = config?.modelCosts as Record<string, ModelPrice> | undefined;
  const overridden = overrides?.[model];
  if (overridden) return { ...overridden, source: "custom" };
  const known = DEFAULT_PRICES[model];
  if (known) return known;
  // Unknown model: assume local = free, or a mid-range default if it looks cloud.
  const isCloud = model.includes(":cloud") || model.includes("/cloud");
  return isCloud
    ? { inputPerM: 0.5, outputPerM: 1.5, source: "ollama-cloud" }
    : { inputPerM: 0, outputPerM: 0, source: "custom" };
}

export function modelIsLocal(model: string): boolean {
  const p = DEFAULT_PRICES[model];
  if (p) return false; // known cloud price → not local
  // No known price + not cloud-suffixed → assume local (free, time-cost only).
  return !(model.includes(":cloud") || model.includes("/cloud"));
}

// Cost of a token count against a price table. tokensPerM scales per-million.
export function costForTokens(p: ModelPrice, tokens: number, kind: "input" | "output"): number {
  const rate = kind === "input" ? p.inputPerM : p.outputPerM;
  return (tokens / 1_000_000) * rate;
}
