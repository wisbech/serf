# Serf: Project-as-Config Infrastructure Plan v2

> The project is the config. Serf is a portable dark factory: install once, run in any repo, and define all behavior inside that repo's `.serf/` folder.

## Why This Direction

We keep hitting machine-specific state: `~/.config/ghostty`, global `opencode` model aliases, `~/.serf/config.json`, system terminals, user dotfiles. That couples the factory to the factory floor. The user wants serf to work like a manufacturing plant — the plant is installed once, but each production run is configured by the work order (the project), not by rewriting the building.

## Principles (inspired by PAI + LifeOS, constrained to per-project)

1. **The folder IS the state.** Every project has its own `.serf/` folder. No central database. No machine-wide registry. Turn the project off and on; any agent reads the folder and continues.
2. **Project `.serf/` is the only source of truth for serf behavior.** All identities, board state, knowledge, events, and config live there.
3. **Global state is read-only and optional.** Serf may inspect the environment (is `opencode` installed? is `herdr` running? what package manager is present?), but it never writes to `~/.config`, `~/.serf`, or system paths to configure itself.
4. **Capabilities are detected, not assumed.** Serf asks questions and degrades gracefully.
5. **Text over opaque storage.** Markdown and JSONL everywhere. If you can't `cat` it, serf doesn't store it.
6. **Package managers only.** No `curl | bash`, no global installs, no system directory writes.
7. **Worktrees today, containers tomorrow.** Short-term isolation = git worktrees. Long-term = project-defined containers (Apple Container / NanoClaw) so the host matters even less.
8. **Self-improvement through folder state.** Skills, patterns, and failures accumulate in `.serf/knowledge/` and are read by future serfs.

## `.serf/` Folder Structure

```
.serf/
├── plan.md              # project mission + current direction
├── config.json          # per-project serf config
├── board/
│   ├── backlog/
│   ├── in-progress/
│   ├── review/
│   └── done/
├── serfs/
│   ├── master.md        # master identity
│   ├── actor.md         # actor identity
│   └── critic.md        # critic identity
├── knowledge/
│   ├── skills/          # reusable capabilities
│   ├── patterns/        # recurring solutions
│   ├── failures/        # what didn't work
│   └── references/      # research findings
├── workspaces/
│   ├── actor/.serf/
│   └── critic/.serf/
├── worktrees/           # per-task git worktrees
├── events/              # JSONL audit trail
└── containers/          # optional container definitions (future)
```

### `.serf/config.json`

```json
{
  "agent": "opencode",
  "model": "ollama/kimi-k2.7-code:cloud",
  "backend": "ollama",
  "terminal": "auto",
  "transport": "herdr"
}
```

If missing, serf uses defaults and tells the user how to create it. No global fallback.

## What Gets Removed or Moved

| Current machine state | New behavior |
|---|---|
| `~/.serf/config.json` | `.serf/config.json` in project root |
| `~/.config/ghostty/config` touched by serf | Never touched. Use herdr panes or inline temp config. |
| Global model aliases / opencode defaults | Ignored; model is explicit from project config. |
| `~/.serf/` state folder | Deleted. Everything lives in project `.serf/`. |

## Capability Detection at Startup

Serf scans the environment read-only:

1. Is `herdr` reachable? → herdr mode.
2. Is the configured agent on PATH? (`opencode`, `claude`, `aider`, etc.)
3. Is the configured model valid? (validated at first call, fail fast.)
4. What package manager does the project use? (`bun.lockb`, `package-lock.json`, `pyproject.toml`, `uv.lock`, `Cargo.toml`)

Missing capability → clear message: "Install X or set `.serf/config.json` to Y."

## Terminal Strategy (No Global Config)

- **Preferred substrate:** herdr. If running, serf asks herdr to create panes. herdr's own config is herdr's business.
- **Fallback:** launch a terminal with an inline temp config file (created in `/tmp/`, deleted after), or run headlessly in the current terminal.
- **Never:** write to `~/.config/ghostty` or any other user dotfile.

## Containerization Roadmap

- **Phase 1 (now):** git worktrees.
- **Phase 2 (when herdr is solid):** `.serf/containers/` spec using Apple Container or NanoClaw. Built from the project's package manifest.
- **Phase 3 (optional):** per-project devcontainer-like spec reusable in CI.

## Inspiration from PAI / LifeOS

PAI's big ideas that fit serf:

- **Filesystem as context, no RAG.** Markdown files + ripgrep. Serf already does this.
- **Memory that compounds.** `.serf/knowledge/` is exactly this.
- **Skills as deterministic units.** `serf health` runs deterministic checks; prompts wrap code, not the other way around.
- **Text over opaque storage.** Everything is `.md` or `.jsonl`.
- **The Algorithm (Current → Ideal State).** Cards have acceptance criteria; critic verifies; done means criteria pass.

What we deliberately **do not** take from PAI:

- No global `~/.claude/PAI/` tree. Serf is per-project.
- no DA identity layer. The user's coding agent is the master.
- no Pulse daemon. herdr is optional; direct mode is a fallback.

## Acceptance Criteria

1. `~/.config/ghostty/config` restored to original content.
2. `src/v2/executor.ts` no longer reads/writes `~/.config/*`.
3. `src/state.ts` reads `.serf/config.json` only; no global fallback; never writes outside project.
4. `serf init` creates `.serf/config.json` with sensible defaults.
5. A fresh checkout with only `bun` and the chosen agent installed can run `serf init` and get a working factory.
6. README/SERF.md say: "The project is the config."

## Open Questions for Discussion

1. Should serf keep a read-only fallback to `~/.serf/config.json` for a global default, or is that a trap?
2. herdr is external. Should serf bundle a minimal launcher, or remain capability-detected?
3. Do we want `serf install` to install the CLI globally but create zero state beyond the binary?

## Immediate Next Steps

1. ✅ Restore `~/.config/ghostty/config` to original content.
2. 🔄 Finish `src/state.ts` project-local refactor (in progress).
3. 🔄 Update `executor.ts` to not touch global dotfiles.
4. Add `.serf/config.json` creation in `serf init`.
5. Update README/SERF.md.
6. Test on a foreign repo with no pre-existing machine state.
