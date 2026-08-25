# Serf v2 Retrospective — 2026-07-02

## What we were trying to do

Complete the production-ready `production-v1` branch of serf so that a **master serf** can:

1. Run in the user's coding agent (opencode, Claude Code, etc.).
2. Maintain a project kanban in `.serf/`.
3. Spawn **actor** and **critic** serfs inside git worktrees.
4. Execute tasks under a macOS `sandbox-exec` sandbox.
5. Use **herdr** panes so the user can watch and, ideally, interact.
6. Apply a funnel of triage → plan critique → execution + autoimprove → work critic → arbiter → deliberation.
7. Support multiple providers (Ollama, vLLM, OpenAI, Anthropic, Claude Code, Claude Desktop).

## What actually got built

The funnel and supporting infrastructure are mostly in place:

- `src/v2/master.ts` — triage, plan phase, execution, work critic, arbiter, deliberation.
- `src/v2/triage.ts`, `plan-critic.ts`, `work-critic.ts`, `arbiter.ts`, `deliberation.ts`, `budget.ts`, `strategies/`.
- `src/v2/sandbox.ts` — macOS `sandbox-exec` profile generation and runner.
- `src/v2/agent-config.ts` — seeds agent provider config (opencode, etc.) into the sandbox home from `.serf/config.json`.
- `src/v2/herdr.ts` — herdr socket API, pane/workspace helpers, agent command builder.
- `src/v2/providers.ts` — provider detection and command building.
- `.serf/serfs/actor.md`, `critic.md`, `master.md` — serf identities.
- Tests pass: 83/83.

## The problem we are stuck on

**herdr + opencode + sandbox + Ollama does not reliably execute tasks.**

Specifically:

1. When serf launches an interactive opencode TUI in a herdr pane, the pane opens but the prompt is **never injected**. The master waits for an output file that never appears, then the plan critic returns `fail ()` with empty reasoning.
2. Inside the sandbox, opencode has a fake `HOME`. We now seed `~/.config/opencode/opencode.json` with the configured Ollama model, and we pass `PATH` so opencode starts, but prompt delivery into an interactive TUI remains broken.
3. Running a local Ollama model through opencode inside a sandbox is fragile. The model resolution, network access to `localhost:11434`, and provider onboarding flow in opencode all behave differently in a constrained environment than in the user's normal shell.

In short: **we chose "interactive TUI in herdr panes" as the primary transport, but the actual prompt injection mechanism is unreliable.**

## What worked

- Direct headless `opencode run -m <model> < promptfile` works. It respects the model flag, reads the prompt from stdin, writes output files, and exits.
- Seeding `~/.config/opencode/opencode.json` in the sandbox home makes `opencode run` resolve the Ollama model correctly.
- The sandbox profile (allow-default + targeted denies) lets opencode read/write project files without global installs or `~/.config` pollution.
- The funnel logic (triage, plan, critic, arbiter, deliberation) is implemented and unit-tested.

## What did not work

- **Interactive TUI prompt injection via herdr `pane.send_text` + `pane.send_keys`.** The prompt appears not to reach opencode's chat input. We do not know whether the issue is herdr key sequence timing, opencode's input handling, the onboarding overlay, or all three.
- **Trying to preserve a persistent TUI session while also automating prompts.** These two goals are in tension: a TUI designed for human typing is a poor API for an autonomous agent.
- **Using Ollama as the default test LLM inside the sandbox.** Ollama needs network access to `localhost`, provider resolution in a fresh HOME, and the model to be pulled. This created a cascade of environment problems that obscured the real prompt-delivery issue.
- **My own approach.** I reverted to a one-shot `opencode run` hack, then reverted again to interactive, then oscillated. That created churn and made the fix look like a hotfix rather than a designed decision.

## Divergence from the original plans

The original plans (`docs/PRODUCTION.md`, `docs/ADR-001-FUNNEL_AND_ACTOR_CRITIC.md`, `docs/SERF_IMPROVEMENT_PLAN.md`) say:

> herdr first, direct/tmux mode is fallback. Workspace labels show `[task] | serf`; pane labels show `actor | [task]` and `critic | [task]`. The user can watch and interact.

This evolved implicitly into:

> herdr panes must host a persistent, interactive agent TUI session.

That is a stronger claim than the plans make, and it is the claim that is failing. The plans never specified *how* prompts would be injected into the TUI. They assumed it would "just work" once panes existed.

## The real design question now

There are two legitimate, mutually exclusive choices:

### Option A: One-shot commands in herdr panes (what I would recommend)

- Keep herdr panes for **visibility**.
- Run `opencode run -m <model> < promptfile` as a one-shot command inside the pane.
- User sees streaming output; agent exits when done; master waits for output file.
- Pro: reliable prompt delivery, works with current opencode behavior, easy to reason about.
- Con: no persistent chat session inside the pane; each turn is a fresh process.

### Option B: Interactive TUI with reliable injection

- Keep the persistent opencode TUI.
- Find or build a reliable way to inject prompts (herdr plugin, opencode slash command, MCP, or opencode server mode).
- Pro: matches the original "watch and interact" vision more closely.
- Con: requires research/integration; may be opencode-specific; higher risk.

### Option C: Drop herdr as primary transport for v1

- Use direct headless execution (`opencode run`, `claude --print`, etc.) as the primary path.
- Keep herdr as an optional visibility layer.
- Pro: simplest to get working end-to-end.
- Con: loses the primary UX differentiator.

## What I would have done differently

1. **Validate the transport first.** Before building the funnel, autoimprove, and deliberation, I should have proven that we can reliably send a prompt from serf to opencode and get a file back — first without herdr, then with herdr, then in a sandbox. That would have exposed the TUI injection problem on day one.

2. **Separate "visibility" from "control."** Herdr panes are great for visibility. They are a bad control surface for automation. I should not have assumed a TUI could be driven like an API.

3. **Pick one agent/provider stack for v1.** Trying to be provider-agnostic while also using Ollama inside a sandbox multiplied the variables. A better v1 target would be: make opencode + Ollama work reliably in sandboxed one-shot mode, then generalize.

4. **Document the transport decision as an ADR before coding.** The original plan left it implicit. An explicit ADR would have prevented the one-shot/interactive oscillation.

5. **Avoid rushed reversions.** When the one-shot path worked, I should have framed it as the intended design rather than a hotfix. Instead I reverted it on your valid feedback, but did not have a real solution for interactive injection.

## Recommended next step

Pause feature work. Decide explicitly between Option A, B, or C. Write the decision into an ADR. Then implement only that path until a single end-to-end task passes in herdr + sandbox + the chosen provider.

My recommendation is **Option A**: one-shot commands in herdr panes. It satisfies "user can watch" and can be extended to better interactivity later, without blocking v1.
