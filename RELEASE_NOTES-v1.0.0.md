# Serf v1.0.0 — Dark Factory for Coding Agents

> Install once. Run in any project. The folder is the state.

## What is Serf?

Serf is an actor-critic harness for coding agents. The master reads the project state, writes tasks to a board, spawns serfs to execute them, and a GAN critic adversarially evaluates output. Knowledge compounds across sessions in `.serf/knowledge/`.

## Installation

```bash
git clone <repo> && cd serf
bun install && bun run build && bun link
serf init          # in any project
serf .             # init (if needed) and start
```

## What's New in v1.0.0

- **Project is the config** — All serf state lives in `.serf/` in the project root. No `~/.serf/` dependency. No global filesystem pollution.
- **Provider detection** — Auto-detects Ollama, vLLM, OpenAI, Anthropic, and Claude Code. Picks the best available provider during `serf init`.
- **Capability detection** — Scans for agents, herdr, package managers, and runtimes at startup.
- **Goal + Lever on every card** — Each task has a single done condition (`Goal`) and a method to achieve it (`Lever`), enforced by card validation.
- **Improved GAN critic** — Anti-cheat detection, evidence-based evaluation, CANNOT_EVALUATE handling for summary-only outputs.
- **Safer agent invocation** — File-based prompts (no shell-expanded `$(cat ...)`), opencode stdin heredoc, better error handling for headless agents.
- **Updated protocol (SERF.md)** — Simplified, with explicit anti-cheat rules and evidence-based acceptance criteria.
- **One branch** — Repository uses `main` only. Clean working tree. No artifacts.

## Verification

```bash
bun test       # 53 tests pass
bun run build  # builds to dist/index.js
serf --help    # prints full usage
```

## Architecture

```
.serf/
├── board/       (backlog → in-progress → review → done)
├── serfs/       (master, actor, critic identities)
├── knowledge/   (skills, patterns, failures, references)
├── workspaces/  (per-agent private state)
├── worktrees/   (per-task isolated git checkouts)
├── events/      (JSONL audit trail)
└── config.json  (project-local configuration)
```

## Components

| Path | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point |
| `src/state.ts` | Project-local config (`.serf/config.json`) |
| `src/v2/master.ts` | Master serf loop |
| `src/v2/board.ts` | Kanban board operations |
| `src/v2/serf.ts` | Serf identities |
| `src/v2/critic.ts` | GAN critic |
| `src/v2/executor.ts` | Agent launcher |
| `src/v2/herdr.ts` | herdr socket client |
| `src/v2/llm.ts` | LLM calls + budget tracker |
| `src/v2/events.ts` | JSONL event stream |
| `src/v2/capabilities.ts` | Runtime capability detection |
| `src/v2/providers.ts` | LLM provider detection |
| `src/v2/knowledge.ts` | Knowledge management |

## Known Limitations

- herdr integration requires herdr to be running for full pane management
- Direct mode (fallback) is less reliable than herdr mode
- No container isolation yet (worktrees only)
- Strategy rings (`autoimprove`, `autoresearch`) are defined but not fully operational
