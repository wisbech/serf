import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Provider = "ollama" | "vllm" | "openai" | "anthropic" | "claude-code" | "claude-desktop" | "unknown";

export interface ProviderConfig {
  provider: Provider;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface ProviderInfo {
  name: Provider;
  label: string;
  reachability: "available" | "needs-auth" | "unavailable";
  models?: string[];
  error?: string;
  preferredLocal?: boolean;
}

const PROVIDERS: Provider[] = ["ollama", "vllm", "openai", "anthropic", "claude-code", "claude-desktop"];

export function listProviders(): Provider[] {
  return [...PROVIDERS];
}

export async function detectProviders(): Promise<ProviderInfo[]> {
  const results: ProviderInfo[] = [];
  for (const p of PROVIDERS) {
    results.push(await detectProvider(p));
  }
  return results;
}

async function detectProvider(provider: Provider): Promise<ProviderInfo> {
  switch (provider) {
    case "ollama":
      return detectOllama();
    case "vllm":
      return detectVllm();
    case "openai":
      return detectOpenAI();
    case "anthropic":
      return detectAnthropic();
    case "claude-code":
      return detectClaudeCode();
    case "claude-desktop":
      return detectClaudeDesktop();
    default:
      return { name: "unknown", label: "Unknown", reachability: "unavailable" };
  }
}

function httpGet(url: string, timeoutMs = 2000): Promise<{ ok: boolean; body: string; status?: number }> {
  return new Promise((resolve) => {
    const http = url.startsWith("https:") ? require("node:https") : require("node:http");
    const req = http.get(url, { timeout: timeoutMs }, (res: any) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ ok: res.statusCode < 400, body, status: res.statusCode }));
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: "" });
    });
  });
}

function isOnPath(cmd: string): boolean {
  try {
    require("node:child_process").execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], timeoutMs = 3000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const out = require("node:child_process").execSync(`${cmd} ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: out, stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

async function detectOllama(): Promise<ProviderInfo> {
  if (!isOnPath("ollama")) {
    return { name: "ollama", label: "Ollama (local)", reachability: "unavailable", error: "ollama not on PATH" };
  }
  const r = httpGet("http://localhost:11434/api/tags");
  const { ok, body } = await r;
  if (!ok) {
    return { name: "ollama", label: "Ollama (local)", reachability: "unavailable", error: "ollama server not responding on localhost:11434" };
  }
  try {
    const data = JSON.parse(body);
    const models = (data.models || []).map((m: any) => m.name || m.model).filter(Boolean);
    return { name: "ollama", label: "Ollama (local)", reachability: "available", models, preferredLocal: true };
  } catch {
    return { name: "ollama", label: "Ollama (local)", reachability: "available", preferredLocal: true };
  }
}

async function detectVllm(): Promise<ProviderInfo> {
  const endpoint = process.env.VLLM_ENDPOINT || "http://localhost:8000/v1";
  const { ok, body } = await httpGet(`${endpoint}/models`);
  if (!ok) {
    return { name: "vllm", label: "vLLM / OpenAI-compatible", reachability: "unavailable", error: `no server at ${endpoint}` };
  }
  try {
    const data = JSON.parse(body);
    const models = (data.data || []).map((m: any) => m.id).filter(Boolean);
    return { name: "vllm", label: "vLLM / OpenAI-compatible", reachability: "available", models };
  } catch {
    return { name: "vllm", label: "vLLM / OpenAI-compatible", reachability: "available" };
  }
}

async function detectOpenAI(): Promise<ProviderInfo> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { name: "openai", label: "OpenAI / OpenAI-compatible", reachability: "needs-auth", error: "OPENAI_API_KEY not set" };
  }
  const endpoint = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const { ok } = await httpGet(`${endpoint}/models`, 3000);
  if (!ok) {
    return { name: "openai", label: "OpenAI / OpenAI-compatible", reachability: "needs-auth", error: `could not reach ${endpoint} with key` };
  }
  return { name: "openai", label: "OpenAI / OpenAI-compatible", reachability: "available" };
}

async function detectAnthropic(): Promise<ProviderInfo> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { name: "anthropic", label: "Anthropic API", reachability: "needs-auth", error: "ANTHROPIC_API_KEY not set" };
  }
  return { name: "anthropic", label: "Anthropic API", reachability: "available" };
}

async function detectClaudeCode(): Promise<ProviderInfo> {
  if (!isOnPath("claude")) {
    return { name: "claude-code", label: "Claude Code CLI", reachability: "unavailable", error: "claude not on PATH" };
  }
  const { ok, stdout, stderr } = run("claude", ["--version"]);
  const combined = `${stdout}\n${stderr}`;
  if (!ok) {
    return { name: "claude-code", label: "Claude Code CLI", reachability: "unavailable", error: combined || "claude --version failed" };
  }
  if (isLoginLike(combined)) {
    return { name: "claude-code", label: "Claude Code CLI", reachability: "needs-auth", error: "Claude Code requires login" };
  }
  return { name: "claude-code", label: "Claude Code CLI", reachability: "available" };
}

async function detectClaudeDesktop(): Promise<ProviderInfo> {
  const macApp = "/Applications/Claude.app";
  const macArmApp = "/Applications/Anthropic Claude.app";
  if (process.platform === "darwin" && (existsSync(macApp) || existsSync(macArmApp))) {
    return { name: "claude-desktop", label: "Claude Desktop", reachability: "available", error: "Claude Desktop found. Use MCP or claude-local bridge to send prompts." };
  }
  return { name: "claude-desktop", label: "Claude Desktop", reachability: "unavailable", error: "Claude Desktop not found" };
}

const LOGIN_MARKERS = [
  "Not logged in",
  "Please run /login",
  "Please log in",
  "Login Required",
  "Authentication required",
  "API key not found",
  "Session not found",
  "not authenticated",
];

export function isLoginLike(text: string): boolean {
  return LOGIN_MARKERS.some((m) => text.toLowerCase().includes(m.toLowerCase()));
}

export function preferredProvider(infos: ProviderInfo[]): ProviderInfo | null {
  // Prefer available local providers first, then available remote, then needs-auth.
  const available = infos.filter((i) => i.reachability === "available");
  const local = available.find((i) => i.preferredLocal);
  if (local) return local;
  if (available.length > 0) return available[0];
  const needsAuth = infos.find((i) => i.reachability === "needs-auth");
  if (needsAuth) return needsAuth;
  return null;
}

export function defaultModelForProvider(provider: Provider): string {
  switch (provider) {
    case "ollama":
      return "ollama/qwen3:8b";
    case "vllm":
      return "local-model";
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-sonnet-4-20250514";
    case "claude-code":
      return "claude-sonnet-4-20250514";
    case "claude-desktop":
      return "claude-sonnet-4-20250514";
    default:
      return "claude-sonnet-4-20250514";
  }
}

export function buildAgentCommand(agent: string, provider: Provider, model?: string, endpoint?: string): string[] {
  const m = model ?? defaultModelForProvider(provider);
  switch (agent) {
    case "opencode": {
      const args = ["run"];
      if (model) args.push("--model", model);
      return args;
    }
    case "claude": {
      // Claude Code supports --provider and --model via settings/env; we keep it simple.
      const args = ["--print"];
      return args;
    }
    case "aider":
      return ["--yes-always"];
    case "pi":
      return ["--print"];
    case "hermes":
      return ["chat", "-Q"];
    case "codex":
      return ["--print"];
    default:
      return [];
  }
}

export function providerInstructions(provider: Provider): string {
  switch (provider) {
    case "ollama":
      return "Install ollama, pull a model (`ollama pull qwen3:8b`), and ensure the server is running.";
    case "vllm":
      return "Start a vLLM or OpenAI-compatible server and set endpoint in .serf/config.json.";
    case "openai":
      return "Set OPENAI_API_KEY or use an OpenAI-compatible baseURL.";
    case "anthropic":
      return "Set ANTHROPIC_API_KEY.";
    case "claude-code":
      return "Run `claude /login` to authenticate, then use serf with agent claude.";
    case "claude-desktop":
      return "Use Claude Desktop with an MCP server or the claude-local bridge to expose it to serf.";
    default:
      return "Set provider, model, and endpoint in .serf/config.json.";
  }
}
