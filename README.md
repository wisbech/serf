# Serf

> A dark factory where a master serf coordinates work, serfs execute tasks, a GAN critic enforces quality, and a folder holds all state.

Serf is a protocol + CLI for managing coding agents. The `.serf/` folder in your project IS the state — no database, no daemon. Any coding agent that reads `SERF.md` becomes a serf.

## Quick Start

```bash
# Clone and link (local, not global)
git clone https://github.com/wisbech/serf.git
cd serf
bun install
bun run build
bun link

# Or run directly without linking
bun run src/index.ts init

# Initialize in your project
cd your-project
serf init

# The default way to use serf: init (if needed) + start
serf .
```

`serf .` (or `serf start`) launches your coding agent as the master serf. It surveys the project, discusses with you what to work on, writes tasks to the board, executes them, and critiques them — all in the agent's own interface.

## How It Works

```
You: serf .
  → detects project, creates .serf/ if missing
  → launches coding agent as master serf
  → agent surveys project + .serf/ folder
  → shows you a review: what's here, what's on the board
  → you discuss what to work on
  → agent writes task card to board
  → agent executes (reads actor identity from .serf/serfs/actor.md)
  → agent's output is evaluated by the GAN critic (multi-pass LLM)
  → if pass: done, asks "what's next?"
  → if fail: retry with feedback (max 3)
  → if uncertain: logged as curiosity point, human judgment at boundary
```

## The Folder

```
.serf/
├── config.json          # project-local settings (agent, model, provider, backend)
├── plan.md              # project mission and direction
├── board/               # kanban (backlog → in-progress → review → done)
├── serfs/               # agent identities (actor, critic, spawned serfs)
├── knowledge/           # accumulated learning
│   ├── skills/          #   what works
│   ├── patterns/        #   curiosity points, recurring solutions
│   ├── failures/        #   what didn't work and why
│   └── references/      #   research findings
├── workspaces/          # per-agent private state
│   ├── actor/.serf/     #   actor's last-state, context
│   └── critic/.serf/    #   critic's verdicts, calibration
├── worktrees/           # per-task isolated git checkouts (best-effort)
└── events/              # append-only audit trail (JSONL)
```

The folder evolves. Every task adds to it. Knowledge compounds. A serf starting a task reads accumulated skills, patterns, and failures — it benefits from everything the factory has learned.

## The GAN Critic

The critic evaluates actor output against the task's acceptance criteria. By default it's an inline multi-pass LLM call. When herdr is running, it can be a separate agent in its own pane with a different model.

- **Per-criterion evaluation** — each acceptance criterion gets YES/NO/CANNOT_EVALUATE with evidence
- **Multi-pass** — N independent evaluations; agreement rate determines confidence
- **Adversarial prompt** — the critic is told to find reasons to FAIL, not to be fair
- **3 fails = bad task** — if a serf fails 3 times, the task description is wrong, not the serf
- **Curiosity** — disagreement between passes is logged to `knowledge/patterns/` for human review at decision boundaries

## Worktree Isolation (Best-Effort)

Each task gets its own git worktree — an isolated checkout where the agent works:

- Critic passes → `git merge --no-ff` brings changes into the main repo
- Critic fails → `git worktree remove --force` discards everything
- The `.serf/` folder is symlinked into the worktree
- Falls back gracefully if the project isn't a git repo or worktree creation fails

## Commands

| Command | What it does |
|---------|-------------|
| `serf .` | Init (if needed) and start — the default entry point |
| `serf init` | Create `.serf/` folder structure in current project |
| `serf start` | Launch master agent — surveys, discusses, processes tasks |
| `serf process [--once] [--budget N]` | Run the board loop in headless mode |
| `serf task "do something"` | Add a card to backlog |
| `serf board [show\|move <id> <column>]` | Show the kanban or move a card |
| `serf agents [list\|use <name>]` | List or select coding agent |
| `serf providers [set <name>]` | List or set LLM provider |
| `serf config [show\|set <k> <v>]` | Show or set project config |
| `serf health [--gan] [--strict]` | Build + test + typecheck |

## Configuration

Project-local config (`.serf/config.json`):

```json
{
  "agent": "claude",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "backend": "anthropic",
  "transport": "herdr"
}
```

**Supported agents:** claude, opencode, aider, pi, hermes, codex (headless), cursor, code (interactive).

**Supported providers:** ollama (local), vLLM/OpenAI-compatible, OpenAI API, Anthropic API, Claude Code CLI, Claude Desktop (via MCP).

**Different model for the critic:** serf can use a different model for the critic than the actor:

```json
{
  "agent": "claude",
  "model": "claude-sonnet-4-20250514",
  "criticAgent": "claude",
  "criticModel": "opus"
}
```

## herdr Integration

[herdr](https://github.com/wisbech/herdr) is an optional terminal substrate. When running, serf uses it to:

- Launch actor and critic in separate panes (visible side by side)
- Detect agent state (working/idle/blocked)
- Spawn specialized serfs as new panes when the actor struggles

Without herdr, serf runs in direct mode — spawning agents sequentially in terminal windows using the configured terminal app (Ghostty, Terminal, iTerm2, tmux, or fallback).

## Philosophy

- **The folder is the state.** Turn it off, turn it on — any agent reads the folder and continues
- **The coding agent is the interface.** No terminal menus, no stdin prompts — the dialogue happens in your agent's own UI
- **Project-is-config.** Settings live in `.serf/config.json`, not in global state
- **The critic is adversarial.** It searches for problems, not partial credit
- **Worktrees isolate.** Each task is sandboxed. Merge on pass, discard on fail
- **Knowledge compounds.** Skills, patterns, and failures accumulate in `.serf/knowledge/` — the factory gets smarter
- **3 fails = bad task.** If a serf fails 3 times, the task description is wrong, not the serf
- **Budget is the hard stop.** Tokenmaxxing prevented by budget tracking on every call

## Future / Strategy Rings

The following features are aspirational and not yet implemented:

- **Autoresearch** — automatic investigation of new topics before task execution
- **Autoimprove** — the system identifies improvement opportunities from failure patterns
- **Context splitting** — automatic spawn of sub-serfs when context exceeds 80%
- **`serf tidy`** — librarian command to prune stale state from `.serf/`

## Limitations

- Worktree isolation requires git and is best-effort (falls back gracefully)
- The critic is an LLM call, not a truly independent agent, unless herdr is running with a separate pane
- herdr integration is developed but not yet battle-tested at scale
- The system runs one task at a time; no parallel multi-agent execution
- Budget tracking is simple token counting, not true cost accounting

## Architecture

```
┌──────────────────────────────────────────────────┐
│  YOUR PROJECT                                     │
│                                                   │
│  .serf/                    Coding agent            │
│  ├── config.json           (claude, opencode,     │
│  ├── board/                aider, codex, etc)     │
│  │   ├── backlog/                                 │
│  │   ├── in-progress/      ┌─────────────────────┐│
│  │   ├── review/           │  Master Serf        ││
│  │   └── done/             │  surveys + talks    ││
│  ├── serfs/                ├─────────────────────┤│
│  │   ├── actor.md           │  Actor              ││
│  │   └── critic.md          │  executes the task  ││
│  ├── knowledge/            ├─────────────────────┤│
│  ├── workspaces/           │  GAN Critic         ││
│  │   ├── actor/             │  evaluates (multi-  ││
│  │   └── critic/            │  pass LLM or pane)  ││
│  ├── worktrees/            └─────────────────────┘│
│  └── events/                                      │
│                                                   │
│  herdr (optional)         All state in the folder  │
│  manages panes             No daemon, no database   │
└──────────────────────────────────────────────────┘
```

## References

- `SERF.md` — the protocol (what agents read to become serfs)
- `docs/PLAN.md` — the plan and architectural decisions

## License

MIT
