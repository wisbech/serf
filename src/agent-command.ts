import type { SandboxProfile } from "./sandbox";

export interface AgentInvocation {
  command: string;
  args: string[];
  promptViaStdin: boolean;
  completionMarker: string;
}

export interface InteractiveInvocation {
  command: string;
  args: string[];
  initialPrompt?: string;
}

type Builder = (model?: string) => AgentInvocation;
type InteractiveBuilder = (model?: string, prompt?: string) => InteractiveInvocation;

const REGISTRY: Record<string, Builder> = {
  claude: (m) => ({
    command: "claude",
    args: m ? ["--print", "--model", stripProvider(m)] : ["--print"],
    promptViaStdin: false,
    completionMarker: "SERF_DONE_EXIT_CODE",
  }),
  opencode: (m) => ({
    command: "opencode",
    args: m ? ["run", "--model", m] : ["run"],
    promptViaStdin: true,
    completionMarker: "SERF_DONE_EXIT_CODE",
  }),
  aider: (m) => ({
    command: "aider",
    args: ["--yes-always", ...(m ? ["--model", m] : [])],
    promptViaStdin: false,
    completionMarker: "SERF_DONE_EXIT_CODE",
  }),
  pi: (m) => ({
    command: "pi",
    args: m ? ["--print", "--model", m] : ["--print"],
    promptViaStdin: false,
    completionMarker: "SERF_DONE_EXIT_CODE",
  }),
  codex: (m) => ({
    command: "codex",
    args: m ? ["--print", "--model", stripProvider(m)] : ["--print"],
    promptViaStdin: false,
    completionMarker: "SERF_DONE_EXIT_CODE",
  }),
  hermes: (m) => ({
    command: "hermes",
    args: ["chat", "-q", ...(m ? ["-m", m] : []), "-Q"],
    promptViaStdin: false,
    completionMarker: "SERF_DONE_EXIT_CODE",
  }),
};

const INTERACTIVE_REGISTRY: Record<string, InteractiveBuilder> = {
  claude: (m, prompt) => ({
    command: "claude",
    args: [...(m ? ["--model", stripProvider(m)] : []), ...(prompt ? ["-p", prompt] : [])],
    initialPrompt: prompt,
  }),
  opencode: (m, _prompt) => ({
    command: "opencode",
    args: [...(m ? ["--model", m] : [])],
    initialPrompt: _prompt,
  }),
  aider: (m, prompt) => ({
    command: "aider",
    args: [...(m ? ["--model", m] : []), ...(prompt ? ["--message", prompt] : [])],
    initialPrompt: prompt,
  }),
  pi: (m, prompt) => ({
    command: "pi",
    args: [...(m ? ["--model", m] : []), ...(prompt ? ["-p", prompt] : [])],
    initialPrompt: prompt,
  }),
  codex: (m, prompt) => ({
    command: "codex",
    args: [...(m ? ["--model", m] : []), ...(prompt ? ["-p", prompt] : [])],
    initialPrompt: prompt,
  }),
  hermes: (m, prompt) => ({
    command: "hermes",
    args: ["chat", ...(m ? ["-m", m] : []), ...(prompt ? ["-q", prompt] : [])],
    initialPrompt: prompt,
  }),
};

export function buildInvocation(agent: string, model?: string): AgentInvocation {
  const builder = REGISTRY[agent];
  if (!builder) throw new Error(`unknown agent: ${agent}`);
  return builder(model);
}

function stripProvider(model: string): string {
  if (model.includes("/")) {
    return model.split("/").slice(1).join("/");
  }
  return model;
}

export function buildInteractiveInvocation(agent: string, model?: string, prompt?: string): InteractiveInvocation {
  const builder = INTERACTIVE_REGISTRY[agent];
  if (!builder) throw new Error(`unknown agent: ${agent}`);
  return builder(model, prompt);
}

export function listAgents(): string[] {
  return Object.keys(REGISTRY);
}

export function isHeadless(agent: string): boolean {
  return agent in REGISTRY;
}

export function wrapWithSandbox(invocation: AgentInvocation, profile: SandboxProfile): string {
  const env = `HOME="${profile.homeDir}" TMPDIR="${profile.tmpDir}" PATH="${process.env.PATH}"`;
  const cmdStr = `${invocation.command} ${invocation.args.join(" ")}`;
  return `sandbox-exec -f "${profile.profilePath}" /bin/sh -c 'cd "\$PWD" && ${env} ${cmdStr}'`;
}