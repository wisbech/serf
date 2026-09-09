import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./state";
import { getSerfDir } from "./paths";
import { dataDir, ensureGarden, markRefreshed } from "./garden";

// Per-million-token pricing, read from the garden's data file
// (.serf/data/pricing.json). This is DATA, not code, so prices can be edited
// or refreshed from a provider without recompiling.
//
// Local models not listed cost $0 — the only cost is time.

export interface ModelPrice {
  inputPerM: number;   // $ per million input tokens
  outputPerM: number;  // $ per million output tokens
  source?: "ollama-cloud" | "openrouter" | "custom";
}

interface PriceFile {
  models: Record<string, { inputPerM: number; outputPerM: number }>;
}

const PRICE_FILE = join(dataDir(), "pricing.json");

let cache: PriceFile | null = null;

// Load the price table from .serf/data/pricing.json. Cached to avoid re-reading.
export function loadPriceFile(): PriceFile {
  if (cache) return cache;
  ensureGarden();
  try {
    if (existsSync(PRICE_FILE)) {
      const parsed = JSON.parse(readFileSync(PRICE_FILE, "utf-8"));
      if (parsed?.models) {
        cache = parsed as PriceFile;
        return cache;
      }
    }
  } catch {}
  cache = { models: {} };
  return cache;
}

export function clearPriceCache(): void {
  cache = null;
}

// Write the price table to .serf/data/pricing.json and mark it fresh in the garden.
export function writePriceFile(models: Record<string, { inputPerM: number; outputPerM: number }>): string {
  ensureGarden();
  writeFileSync(PRICE_FILE, JSON.stringify({ models }, null, 2));
  markRefreshed("pricing", 86400); // 24h freshness
  clearPriceCache();
  return PRICE_FILE;
}

// Seed the garden's pricing file from the bundled resources/model-prices.json.
export function seedPriceFile(): string {
  const srcDir = (import.meta.dir) || process.cwd();
  const candidates = [
    join(srcDir, "..", "resources", "model-prices.json"),
    join(srcDir, "..", "..", "resources", "model-prices.json"),
    join(process.cwd(), "resources", "model-prices.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const parsed = JSON.parse(readFileSync(c, "utf-8"));
      return writePriceFile(parsed?.models ?? {});
    }
  }
  return writePriceFile({});
}

export function getPrices(): Record<string, ModelPrice> {
  const data = loadPriceFile();
  return Object.fromEntries(
    Object.entries(data.models).map(([name, p]) => [name, { inputPerM: p.inputPerM, outputPerM: p.outputPerM, source: "ollama-cloud" } as ModelPrice]),
  );
}

// Look up pricing for a model name. Local models (running on your own machine)
// cost $0 — the only cost is time. Falls back to a conservative default.
export function modelPrice(model: string, config?: Config): ModelPrice {
  const overrides = config?.modelCosts as Record<string, ModelPrice> | undefined;
  const overridden = overrides?.[model];
  if (overridden) return { ...overridden, source: "custom" };

  const data = loadPriceFile();
  const known = data.models[model];
  if (known) return { inputPerM: known.inputPerM, outputPerM: known.outputPerM, source: "ollama-cloud" };

  // Unknown model: assume local = free, or a mid-range default if it looks cloud.
  const isCloud = model.includes(":cloud") || model.includes("/cloud");
  return isCloud
    ? { inputPerM: 0.5, outputPerM: 1.5, source: "ollama-cloud" }
    : { inputPerM: 0, outputPerM: 0, source: "custom" };
}

export function modelIsLocal(model: string): boolean {
  const data = loadPriceFile();
  if (data.models[model]) return false; // known cloud price → not local
  // No known price + not cloud-suffixed → assume local (free, time-cost only).
  return !(model.includes(":cloud") || model.includes("/cloud"));
}

// Cost of a token count against a price table. tokensPerM scales per-million.
export function costForTokens(p: ModelPrice, tokens: number, kind: "input" | "output"): number {
  const rate = kind === "input" ? p.inputPerM : p.outputPerM;
  return (tokens / 1_000_000) * rate;
}

// For backward compat with any code referencing the old const.
export const DEFAULT_PRICES: Record<string, ModelPrice> = getPrices();
