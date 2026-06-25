# Serf

> A dark factory where a master serf coordinates work, serfs execute tasks, a living critic enforces quality, and a folder holds all state.

Serf is a protocol + CLI for managing coding agents. The `.serf/` folder in your project IS the state — no database, no daemon. Any coding agent that reads `SERF.md` becomes a serf.

## Quick Start

```bash
# Install
git clone https://github.com/wisbech/serf.git
cd serf && npm install -g .

# Initialize in your project
cd your-project
serf init

# Start — launches your coding agent as the master serf
serf start
```

`serf start` spawns your coding agent (Claude Code, opencode, etc.) with a master prompt. The agent surveys the project, shows you what's going on, discusses what to work on, writes the task to the board, executes it, critiques it, and asks "what's next?" — all in the agent's own interface.

## How It Works

```
You: serf start
  → launches coding agent as master serf
  → agent surveys project + .serf/ folder
  → shows you a review: what's here, what's on the board, suggestions
  → you discuss what to work on
  → agent writes task card to board
  → agent executes (reads actor identity)
  → agent critiques (reads critic identity)
  → if pass: done, asks "what's next?"
  → if fail: retry with feedback (max 3)
  → if uncertain: critic asks actor questions → converge or bubble to you
```

## The Folder

```
.serf/
├── board/              # kanban (backlog → in-progress → review → done)
├── serfs/              # agent identities (actor, critic, spawned serfs)
├── knowledge/          # accumulated learning (compounds)
│   ├── skills/         #   what works
│   ├── patterns/       #   curiosity points, recurring solutions
│   ├── failures/       #   what didn't work and why
│   └── references/     #   research findings
├── workspaces/         # per-agent private state
│   ├── actor/.serf/    #   actor's last-state, context
│   └── critic/.serf/   #   critic's verdicts, calibration
├── worktrees/          # per-task isolated git checkouts
├── events/             # append-only audit trail (JSONL)
├── critic/
│   └── thresholds.md   # agreement threshold config
└── plan.md             # project mission
```

The folder evolves. Every task adds to it. Knowledge compounds. A serf starting a task reads accumulated skills, patterns, and failures — it benefits from everything the factory has learned.

## The Living Critic

The critic is not a function call. It's an agent with its own identity, memory, and voice.

- **Per-criterion evaluation** — each acceptance criterion gets YES/NO/CANNOT_EVALUATE with evidence, not generic axes with confidence scores
- **Multi-pass** — N independent evaluations; agreement rate replaces self-assessed confidence
- **Dialogue** — when uncertain, the critic asks the actor a question. They converge through conversation. If they can't, it bubbles to you.
- **Curiosity** — disagreement between passes is the curiosity signal (Schmidhuber's intrinsic motivation). Curiosity points are logged to `knowledge/patterns/` for human review at decision boundaries
- **Transparency** — the critic can read the actor's workspace to understand *why* choices were made, not just what was produced

## Worktree Isolation

Each task gets its own git worktree — an isolated checkout where the agent works:

- Critic passes → `git merge --no-ff` brings changes into the main repo
- Critic fails → `git worktree remove --force` discards everything
- The main repo is never touched by in-progress work

The `.serf/` folder is symlinked into the worktree, so all agents share the same board, knowledge, and identities.

## Commands

| Command | What it does |
|---------|-------------|
| `serf init` | Create `.serf/` folder structure in current project |
| `serf start` | Launch master agent — surveys, discusses, processes tasks (default) |
| `serf task "do something"` | Add a card to backlog directly |
| `serf board` | Show the kanban (backlog/in-progress/review/done) |
| `serf board move <id> <column>` | Move a card |
| `serf agents [list\|use <name>]` | List or select coding agent |
| `serf config [show\|set <k> <v>]` | Show or set config |
| `serf health [--gan] [--strict]` | Build + test + typecheck |

## Configuration

Global config (`~/.serf/config.json`):

```json
{
  "agent": "claude",
  "model": "claude-sonnet-4-20250514",
  "backend": "anthropic"
}
```

**Supported agents:** claude, opencode, aider, pi, hermes, codex (headless), cursor, code (interactive).

**Different model for the critic:** serf can use a different model for the critic than the actor for architectural separation:

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
- Detect agent state (working/idle/blocked) — no polling
- Spawn specialized serfs as new panes when the actor struggles

Without herdr, serf runs in direct mode — spawning agents sequentially with terminal windows.

## Philosophy

- **The folder is the state.** Turn it off, turn it on — any agent reads the folder and continues
- **The coding agent is the interface.** No terminal menus, no stdin prompts — the dialogue happens in your agent's own UI
- **The critic is alive.** It explores, gets curious, asks questions, and converges with the actor through dialogue
- **Worktrees isolate.** Each task is sandboxed. Merge on pass, discard on fail
- **Knowledge compounds.** Skills, patterns, and failures accumulate in `.serf/knowledge/` — the factory gets smarter
- **3 fails = bad task.** If a serf fails 3 times, the task description is wrong, not the serf
- **Budget is the hard stop.** Tokenmaxxing prevented by budget tracking on every call

## Architecture

```
┌──────────────────────────────────────────────────┐
│  YOUR PROJECT                                     │
│                                                   │
│  .serf/                    Coding agent            │
│  ├── board/                (claude, opencode,     │
│  │   ├── backlog/           codex, aider, etc)     │
│  │   ├── in-progress/                              │
│  │   ├── review/          ┌─────────────────────┐ │
│  │   └── done/            │  Master Serf        │ │
│  ├── serfs/               │  surveys + talks    │ │
│  │   ├── actor.md          ├─────────────────────┤ │
│  │   └── critic.md         │  Actor              │ │
│  ├── knowledge/           │  executes the task  │ │
│  ├── workspaces/          ├─────────────────────┤ │
│  │   ├── actor/            │  Critic            │ │
│  │   └── critic/           │  evaluates, asks    │ │
│  ├── worktrees/           │  questions, conv'g  │ │
│  └── events/              └─────────────────────┘ │
│                                                   │
│  herdr (optional)         All state in the folder  │
│  manages panes             No daemon, no database   │
└──────────────────────────────────────────────────┘
```

## References

- `SERF.md` — the protocol (what agents read to become serfs)
- `.serf/knowledge/skills/living-critic-architecture.md` — the living critic design
- `.serf/knowledge/skills/worktree-isolation-plan.md` — worktree + workspace isolation
- `.serf/knowledge/skills/interactive-task-intake-plan.md` — interactive intake design

## License

MIT