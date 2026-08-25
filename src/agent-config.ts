import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./state";

export interface SeedResult {
  /** Extra environment variables to set when the agent runs. */
  env: Record<string, string>;
  /** Files written into the sandbox home directory. */
  files: Array<{ path: string; content: string }>;
}

/**
 * Seed agent-specific configuration into a sandbox home directory.
 * All configuration comes from .serf/config.json (project-is-config).
 * API keys are passed as environment variables, never written to files.
 */
export function seedAgentEnvironment(homeDir: string, config: Config): SeedResult {
  const files: Array<{ path: string; content: string }> = [];
  const env: Record<string, string> = {};

  if (config.agent === "opencode") {
    files.push(...seedOpencodeConfig(homeDir, config));
  }

  // Write all seed files to disk. Directories are created as needed.
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf-8");
  }

  // API keys: prefer referencing a named env var, fall back to the literal key.
  if (config.apiKeyEnv) {
    const key = process.env[config.apiKeyEnv];
    if (key) env[config.apiKeyEnv] = key;
  } else if (config.apiKey) {
    const envVar = apiKeyEnvName(config.provider);
    if (envVar) env[envVar] = config.apiKey;
  }

  // Provider-specific endpoint environment variables.
  if (config.endpoint) {
    const envVar = endpointEnvName(config.provider);
    if (envVar) env[envVar] = config.endpoint;
  }

  return { env, files };
}

function seedOpencodeConfig(homeDir: string, config: Config): Array<{ path: string; content: string }> {
  const parsed = parseModelSpec(config.model, config.provider);
  if (!parsed) return [];

  const configDir = join(homeDir, ".config", "opencode");

  const providerConfig = buildOpencodeProvider(parsed.provider, parsed.model, config);
  const opencodeJson = {
    "$schema": "https://opencode.ai/config.json",
    provider: {
      [parsed.provider]: providerConfig,
    },
  };

  return [
    {
      path: join(configDir, "opencode.json"),
      content: JSON.stringify(opencodeJson, null, 2),
    },
  ];
}

export function parseModelSpec(model: string, provider?: string): { provider: string; model: string } | null {
  if (model.includes("/")) {
    const [p, ...rest] = model.split("/");
    return { provider: p, model: rest.join("/") };
  }
  if (provider && provider !== "unknown") {
    return { provider, model };
  }
  return null;
}

function buildOpencodeProvider(provider: string, model: string, config: Config): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: providerName(provider),
    npm: npmPackageForProvider(provider),
    models: {
      [model]: {
        _launch: true,
        name: model,
      },
    },
  };

  const options: Record<string, string> = {};
  if (config.endpoint) {
    options.baseURL = config.endpoint;
  } else if (provider === "ollama") {
    options.baseURL = "http://localhost:11434/v1";
  }

  if (Object.keys(options).length > 0) {
    base.options = options;
  }

  return base;
}

function providerName(provider: string): string {
  switch (provider) {
    case "ollama":
      return "Ollama";
    case "vllm":
      return "vLLM";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    default:
      return provider;
  }
}

function npmPackageForProvider(provider: string): string {
  switch (provider) {
    case "ollama":
    case "vllm":
      return "@ai-sdk/openai-compatible";
    case "openai":
      return "@ai-sdk/openai";
    case "anthropic":
      return "@ai-sdk/anthropic";
    default:
      return "@ai-sdk/openai-compatible";
  }
}

function apiKeyEnvName(provider?: string): string | null {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    default:
      return null;
  }
}

function endpointEnvName(provider?: string): string | null {
  switch (provider) {
    case "openai":
      return "OPENAI_BASE_URL";
    case "vllm":
      return "VLLM_ENDPOINT";
    default:
      return null;
  }
}
