import { describe, it, expect } from "bun:test";
import {
  isLoginLike,
  defaultModelForProvider,
  buildAgentCommand,
  providerInstructions,
  listProviders,
} from "../src/providers";

describe("Providers", () => {
  it("detects login markers", () => {
    expect(isLoginLike("Not logged in · Please run /login")).toBe(true);
    expect(isLoginLike("Please log in to continue")).toBe(true);
    expect(isLoginLike("Authentication required")).toBe(true);
    expect(isLoginLike("API key not found")).toBe(true);
  });

  it("does not false-positive normal output", () => {
    expect(isLoginLike("Hello! How can I help you today?")).toBe(false);
    expect(isLoginLike("Added the comment to src/index.ts")).toBe(false);
    expect(isLoginLike("Not a login problem")).toBe(false);
  });

  it("provides default models per provider", () => {
    expect(defaultModelForProvider("ollama")).toContain("ollama/");
    expect(defaultModelForProvider("anthropic")).toContain("claude-");
    expect(defaultModelForProvider("claude-code")).toContain("claude-");
    expect(defaultModelForProvider("openai")).toContain("gpt-");
  });

  it("builds opencode command with model", () => {
    const args = buildAgentCommand("opencode", "ollama", "ollama/qwen3:8b");
    expect(args).toContain("run");
    expect(args).toContain("--model");
    expect(args).toContain("ollama/qwen3:8b");
  });

  it("builds claude command", () => {
    const args = buildAgentCommand("claude", "anthropic");
    expect(args).toContain("--print");
  });

  it("lists known providers", () => {
    expect(listProviders()).toContain("ollama");
    expect(listProviders()).toContain("vllm");
    expect(listProviders()).toContain("openai");
  });

  it("provides instructions for each provider", () => {
    expect(providerInstructions("ollama")).toContain("ollama");
    expect(providerInstructions("vllm")).toContain("OpenAI-compatible");
    expect(providerInstructions("anthropic")).toContain("ANTHROPIC_API_KEY");
  });
});
