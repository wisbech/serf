import { loadConfig } from "../state";

export interface BudgetConfig {
  maxTokensPerHarvest: number;
  costPerToken: number;
  maxSpendPerHarvest: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxTokensPerHarvest: 100_000,
  costPerToken: 0.00001,
  maxSpendPerHarvest: 5.0,
};

export class BudgetTracker {
  private tokensUsed = 0;
  private totalCost = 0;

  constructor(private config: BudgetConfig = DEFAULT_BUDGET_CONFIG) {}

  track(tokens: number) {
    this.tokensUsed += tokens;
    this.totalCost += tokens * this.config.costPerToken;
  }

  isOverBudget(): boolean {
    return this.tokensUsed > this.config.maxTokensPerHarvest || this.totalCost > this.config.maxSpendPerHarvest;
  }

  getStats() {
    return {
      tokensUsed: this.tokensUsed,
      totalCost: this.totalCost,
      budgetRemaining: this.config.maxSpendPerHarvest - this.totalCost,
    };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function detectGibberish(text: string): boolean {
  if (text.length < 100) return false;
  const nonAlpha = text.replace(/[a-zA-Z0-9\s\n\r\t.,;:!?'"(){}\[\]/\\@#$%^&*\-_+=<>~`|]/g, "").length;
  return nonAlpha / text.length > 0.3;
}

export interface CallLLMOptions {
  model?: string;
  systemPrompt?: string;
  budgetTracker?: BudgetTracker;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CallLLMResult {
  text: string;
  tokensUsed: number;
  warnings: string[];
  ok: boolean;
}

export async function callLLM(prompt: string, options: CallLLMOptions = {}): Promise<CallLLMResult> {
  const config = loadConfig();
  const backend = config?.backend || "ollama";
  const model = options.model || config?.model || "qwen3.5";
  const warnings: string[] = [];

  const promptTokens = estimateTokens(prompt);
  let tokensUsed = promptTokens;

  if (options.budgetTracker) {
    options.budgetTracker.track(promptTokens);
    if (options.budgetTracker.isOverBudget()) {
      return { text: "[BUDGET_EXCEEDED]", tokensUsed, warnings: ["budget-exceeded"], ok: false };
    }
  }

  let text = "";

  if (backend === "ollama") {
    const body: any = { model, prompt, stream: false };
    if (options.systemPrompt) body.system = options.systemPrompt;

    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    const json = await response.json() as any;
    if (json.error) return { text: "", tokensUsed, warnings: [`ollama-error: ${json.error.message}`], ok: false };
    text = json.response || "";
  } else {
    const key = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!key) return { text: "", tokensUsed, warnings: ["no-api-key"], ok: false };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 4096,
        system: options.systemPrompt ?? "You are a serf. Respond directly with your work.",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    const json2 = await response.json() as any;
    if (json2.error) return { text: "", tokensUsed, warnings: [`api-error: ${json2.error.message}`], ok: false };
    text = json2.content?.[0]?.text || "";
  }

  const responseTokens = estimateTokens(text);
  tokensUsed += responseTokens;

  if (options.budgetTracker) {
    options.budgetTracker.track(responseTokens);
    if (options.budgetTracker.isOverBudget()) warnings.push("budget-exceeded");
  }

  if (detectGibberish(text)) warnings.push("possible-gibberish");

  return { text, tokensUsed, warnings, ok: text.length > 0 && !warnings.includes("budget-exceeded") };
}

export { estimateTokens, detectGibberish };