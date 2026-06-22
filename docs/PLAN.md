# Serf — Plan v2

> **One canonical plan.** The system was over-architected; this plan is the simplified version. v1 is archived in git history.

---

## Scope & Stance

Serf is a dark factory where a **master serf** coordinates work, **serfs** execute tasks, a **GAN critic** enforces quality, and a **folder** holds all state. No humans write code or review outcomes. The user expresses a need, the master breaks it down, serfs execute, the critic enforces, the user accepts or refines.

**What Serf is:** A protocol (`SERF.md`) + CLI tooling. Any coding agent that reads `SERF.md` becomes a serf. The `.serf/` folder IS the state.

**What Serf is not:** A turnkey company. A multi-agent swarm at scale. A validated production system.

---

## Architecture

```
herdr (optional substrate — Rust binary, manages panes, detects agent state, socket API)
  │
  ├── master pane (agent reading SERF.md, running the master protocol)
  │     └── talks to herdr socket: spawn serfs, check state, read output
  │
  ├── executor pane (agent with a serf identity, executing a task)
  ├── critic pane (different model, GAN critique prompt)
  │
  └── .serf/ (project-local folder state)
      ├── plan.md          # mission + direction
      ├── board/            # kanban (backlog/in-progress/review/done)
      ├── serfs/            # identities (mission/persona/lever/measurement/last-state)
      ├── knowledge/        # what we know (skills, patterns, failures)
      └── events/           # what happened (JSONL append-only)
```

**SERF.md** is the protocol. Any coding agent that reads it becomes a serf. No installation, no process, no runtime. Just instructions + folder state.

**herdr** is optional. When running, the master can spawn real agent panes and check their state natively. When not running, the master calls the LLM directly.

**The folder IS the state.** Turn it off, turn it on — any agent reads the folder and continues. No database, no running state.

---

## Code Structure

```
src/
├── index.ts           # CLI (init, task, board, start, health) — ~200 lines
├── state.ts           # config (loadConfig, saveConfig) — ~30 lines
└── v2/
    ├── llm.ts         # callLLM + BudgetTracker + gibberish detection — ~100 lines
    ├── board.ts       # kanban as folders (cards as .md files) — ~200 lines
    ├── serf.ts        # serf identities (read, write, morph, spawn, deprecate) — ~130 lines
    ├── critic.ts      # GAN critic (buildCritiquePrompt + parseVerdict) — ~100 lines
    ├── master.ts      # the master serf loop — ~250 lines
    ├── herdr.ts       # herdr socket client (optional) — ~200 lines
    └── events.ts      # JSONL event stream — ~60 lines

Total: ~1000 lines of source + 3 test files (26 tests)
Build: 37 KB, 9 modules
```

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Master serf replaces harvest modules | Intelligence in the master, not in orchestration code |
| 2 | Folder IS the state | Offline → online from files alone. No database. |
| 3 | GAN critic enforces all levels | Serf output, master plans. Nobody is above the law. |
| 4 | Morph before spawn | One LLM morphing personas is cheaper than multiple serfs. |
| 5 | Master's attention IS pruning | No Kuramoto. Idle serfs deprecate when master stops calling them. |
| 6 | Plain folder names | `board/`, `serfs/`, `knowledge/`, `events/`. No metaphors. |
| 7 | Librarian is a command, not a process | `serf tidy` runs when needed. |
| 8 | Budget is the hard stop | Tokenmaxxing prevented by BudgetTracker. |
| 9 | 3 fails = bad task, not bad serf | Cruelty safeguard. |
| 10 | herdr is the substrate (optional) | Rust binary handles PTY + state detection + socket API. |
| 11 | TypeScript for orchestration, Rust for infrastructure | Serf (TS) does board/critic/LLM. herdr (Rust) does terminals. |
| 12 | GAN critic is a pane | Different model in a different pane = adversarial friction. |
| 13 | SERF.md is the protocol, not the code | Any agent reads it, becomes a serf. |
| 14 | .serf/ is project-local | Like .git/. Global config in ~/.serf/config.json. |
| 15 | v1 archived | Kuramoto, pruning, strategy board — not needed until 5+ serfs. |

---

## Status

- ✅ SERF.md protocol (240 lines)
- ✅ README.md (192 lines)
- ✅ CLI: init, task, board, start, health
- ✅ v2 modules: llm, board, serf, critic, master, herdr, events
- ✅ 26 tests passing
- ✅ 37 KB build, 9 modules
- ✅ First real task executed (Genius Machine project)
- ✅ Field notes written (7 fixes applied)
- 🔄 herdr integration (client built, untested with real herdr)
- ⬜ GAN critic as real adversarial pane (needs herdr running)
- ⬜ Context split (spawn when context > 80%)
- ⬜ `serf tidy` command
- ⬜ Published to GitHub

---

_Next: Publish to GitHub, then test from a fresh install as a real user_