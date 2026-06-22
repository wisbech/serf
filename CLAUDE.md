# CLAUDE.md — Serf Agent Harness

## Identity

**Serf** — A dark factory where a master serf coordinates work, serfs execute tasks, a GAN critic enforces quality, and a folder holds all state.

```
Intent → Task on board → Serf executes → GAN critic → Done
```

## What Serf Is

A protocol + CLI for managing coding agents. The protocol lives in `SERF.md` — any agent that reads it becomes a serf. The CLI provides convenience commands (`serf init`, `serf task`, `serf board`, `serf start`). The `.serf/` folder in each project IS the state.

## Architecture

```
serf/
├── README.md          # entry point for users
├── SERF.md            # the protocol (agents read this)
├── docs/PLAN.md       # the plan and decisions
├── src/
│   ├── index.ts       # CLI entry point (~200 lines)
│   ├── state.ts       # config (loadConfig, saveConfig)
│   └── v2/
│       ├── llm.ts     # callLLM + BudgetTracker + gibberish detection
│       ├── board.ts   # kanban as folders (cards as .md files)
│       ├── serf.ts    # serf identities (mission/persona/lever/measurement/fate)
│       ├── critic.ts  # GAN critic (buildCritiquePrompt + parseVerdict)
│       ├── master.ts  # the master serf loop (read board → execute → critique → done)
│       ├── herdr.ts   # herdr socket client (optional substrate)
│       └── events.ts  # JSONL event stream
├── scripts/
│   └── health-check.ts
└── tests/
    ├── v2-board.test.ts
    ├── v2-critic.test.ts
    └── v2-serf.test.ts
```

## Key Principles

1. **The folder IS the state** — `.serf/` in the project root. No database, no daemon.
2. **SERF.md is the protocol** — any agent that reads it becomes a serf
3. **GAN critic enforces quality** — adversarial evaluation, 3 fails = bad task
4. **Budget is the hard stop** — tokenmaxxing prevented by BudgetTracker
5. **herdr is optional** — when running, provides pane management + state detection
6. **Plain folders** — `board/`, `serfs/`, `knowledge/`, `events/`. No jargon in folder names.

## Build & Run

```bash
bun build src/index.ts --outdir dist --target bun
./dist/index.js --help

# Commands
serf init                           # Create .serf/ in project
serf task "do something"            # Add to board
serf board                          # Show kanban
serf start                          # Master processes the board
serf health                         # Build + test + typecheck
```

## Routing Table

| Task | Read First | Notes |
|------|------------|-------|
| Protocol | SERF.md | What agents read to become serfs |
| Board operations | src/v2/board.ts | Cards as .md files, folders as columns |
| Serf identities | src/v2/serf.ts | Mission/persona/lever/measurement/fate |
| GAN critic | src/v2/critic.ts | Adversarial evaluation prompt + verdict parser |
| Master loop | src/v2/master.ts | Read board → execute → critique → done |
| herdr integration | src/v2/herdr.ts | Socket client (optional) |
| LLM calls | src/v2/llm.ts | callLLM + budget + gibberish detection |
| Events | src/v2/events.ts | JSONL append-only audit trail |