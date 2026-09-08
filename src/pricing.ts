import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./state";
import { getSerfDir, ensureDir } from "./paths";

// Per-million-token pricing, read from a JSON data file (resources/model-prices.json
// at the project root, overridable via .serf/pricing.json). This is DATA, not code,
// so prices can be edited or refreshed from a provider without recompiling.
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

const OVERRIDE_PRICE_FILE = join(getSerfDir(), "pricing.json");

// The bundled table lives in the serf package's resources/ dir. When run from
// source that's <repo>/resources/model-prices.json. Try a few candidate roots
// (package root, repo root) so it works whether serf is installed or run from
// a checkout.
function bundledPriceFile(): string {
  const srcDir = (import.meta.dir) || process.cwd();
  const candidates = [
    join(srcDir, "..", "resources", "model-prices.json"), // src/../resources
    join(srcDir, "..", "..", "resources", "model-prices.json"), // repo root
    join(process.cwd(), "resources", "model-prices.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
const BUNDLED_PRICE_FILE = bundledPriceFile();

let cache: PriceFile | null = null;

// Load the price table: project .serf/pricing.json takes precedence, else the
// bundled resources/model-prices.json. Cached to avoid re-reading on every call.
export function loadPriceFile(): PriceFile {
  if (cache) return cache;
  const candidates = [OVERRIDE_PRICE_FILE, BUNDLED_PRICE_FILE];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed?.models) {
        cache = parsed as PriceFile;
        return cache;
      }
    } catch {}
  }
  cache = { models: {} };
  return cache;
}

export function clearPriceCache(): void {
  cache = null;
}

// Write a copy of the bundled price table to .serf/pricing.json for editing.
export function seedPriceFile(): string {
  ensureDir(dirname(OVERRIDE_PRICE_FILE));
  const source = existsSync(BUNDLED_PRICE_FILE) ? readFileSync(BUNDLED_PRICE_FILE, "utf-8") : "{\"models\":{}}";
  writeFileSync(OVERRIDE_PRICE_FILE, source);
  clearPriceCache();
  return OVERRIDE_PRICE_FILE;
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
