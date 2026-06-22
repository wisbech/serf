# Serf

> **A dark factory where a master serf coordinates work, serfs execute tasks, a GAN critic enforces quality, and a folder holds all state.**

Serf is an agent harness. It's not a process you run — it's a protocol you follow. Any coding agent that reads `SERF.md` becomes a serf. The `.serf/` folder in your project IS the state.

## What Serf Does

```
You: "Add this to the board: research TCP vs UDP"
Serf: → reads .serf/board/ → picks up the task → executes → critiques → done
You: "Show me the board"
Serf: → reads .serf/board/ → shows backlog/in-progress/review/done
```

No daemon. No database. No running process. Just a folder, a protocol, and agents that read it.

## Quick Start

### 1. Install serf

```bash
git clone https://github.com/wisbech/serf.git
cd serf
npm install -g .
```

Now `serf` is a global command. Verify:
```bash
serf help
```

### 2. Install herdr (optional but recommended)

Herdr is the terminal substrate — it manages agent panes, detects state (working/blocked/done), and exposes a socket API. Serf uses it when available, falls back to direct LLM calls when not.

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

### 3. Initialize a project

```bash
cd your-project
serf init
```

Creates `.serf/` with board, serfs, knowledge, events, and a master identity.

### 4. Add a task

```bash
serf task "Explain the difference between TCP and UDP"
```

### 5. Tell your agent to work

```
Read SERF.md and follow the protocol. Pick up a task from .serf/board/ and execute it.
```

### 6. Check the board

```bash
serf board
```

## How It Works

```
┌──────────────────────────────────────────────────┐
│  YOUR PROJECT                                     │
│                                                   │
│  .serf/                    Your coding agent       │
│  ├── board/                (pi, claude, opencode,  │
│  │   ├── backlog/           codex, or any agent    │
│  │   ├── in-progress/        that reads SERF.md)   │
│  │   ├── review/                                  │
│  │   └── done/               reads → executes →   │
│  ├── serfs/                  critiques → writes   │
│  ├── knowledge/                                    │
│  └── events/                 herdr (optional)      │
│                               manages panes +      │
│                               detects state        │
└──────────────────────────────────────────────────┘
```

**The protocol is in `SERF.md`.** Any agent that reads it knows how to:
1. Find a task on the board
2. Read its identity (mission, persona, fate)
3. Execute the task
4. Critique the output (GAN critic)
5. Write the result and last state
6. Leave — the folder is complete

**herdr is optional.** When running, it provides:
- Agent state detection (blocked/working/done) — no more `waitForIdle` polling
- Pane management via socket API — spawn serfs as separate panes
- Session persistence — detach and reattach

When herdr is not running, the agent calls the LLM directly (Ollama, Anthropic, etc.) and works solo.

## Commands

| Command | What it does |
|---------|-------------|
| `serf init` | Create `.serf/` folder structure in current project |
| `serf task "do something"` | Add a card to backlog |
| `serf board` | Show the kanban (backlog/in-progress/review/done) |
| `serf start` | Master serf processes the board (needs LLM configured) |
| `serf list` | List running serfs (needs herdr) |
| `serf health` | Build + test + typecheck |
| `serf feedback <card> --accept` | Record user feedback on a done card |

## Configuration

Global config (`~/.serf/config.json`):
```json
{
  "transport": "ollama",
  "model": "minimax-m2.5:cloud",
  "backend": "ollama"
}
```

Set up Ollama:
```bash
# Install: https://ollama.com
ollama pull minimax-m2.5:cloud  # or any model
```

Or use Anthropic:
```json
{
  "transport": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "backend": "anthropic"
}
```

## The GAN Critic

The critic is the quality gate. It evaluates every serf's output against the task and acceptance criteria. If the critic finds high-confidence problems, the serf retries. After 3 failures, the task description is questioned — not the serf.

**The master is also critiqued.** The critic evaluates plans, not just output. Nobody is above the law. The user is the final critic: `serf feedback <card> --accept|--refine`.

## Philosophy

- **The folder is the state.** Turn it off, turn it on — any agent reads the folder and continues.
- **Intelligence in the master.** The master serf plans and delegates. Serfs are dumb with a clear goal.
- **GAN enforcement.** Two agents with different objectives — generator produces, critic rejects.
- **Budget is the hard stop.** Tokenmaxxing prevented by budget tracking on every call.
- **3 fails = bad task.** If a serf fails 3 times, the task description is wrong, not the serf.
- **Plain folders.** `board/`, `serfs/`, `knowledge/`, `events/`. No metaphors in folder names.

## References

- `SERF.md` — the protocol (what agents read)
- `docs/PLAN.md` — the full plan and architecture decisions
- `docs/REVIEW_2026-06-17.md` — the review that simplified everything