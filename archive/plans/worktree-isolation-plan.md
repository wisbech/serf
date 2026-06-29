# Agent Isolation: Worktrees + Per-Agent Workspaces

## Date
2026-06-25

## Status
Plan — awaiting discussion with actor and critic.

## The Problem

Agents run with full filesystem and process access. A rogue agent can:
- Write to `~/.ssh/authorized_keys`, `~/.config`, `/usr/`
- Install packages globally via `curl | bash`
- Read environment variables (secrets, API keys)
- Spawn processes, make network requests, modify system configs
- Delete or overwrite files outside the project

The actor prompt says "stay in the project directory" but nothing enforces it. We need real isolation, not prompt-level wishful thinking.

## The Core Insight

Two separations, not one:

1. **Task isolation** — each card's work is isolated in a git worktree. Critic passes → merge. Fails → discard. The main repo is never touched by in-progress work.

2. **Agent isolation** — each agent (actor, critic, spawned serfs) has its own workspace within `.serf/`. Its identity, its working state, its context. Agents don't share working state — they share the board and the knowledge base.

Together: the worktree isolates the task, the workspace isolates the agent, and the shared `.serf/` is the factory floor where they meet.

## The Folder Structure

```
project-root/
  .serf/                              # SHARED — the factory floor
    plan.md                           # mission + direction (read-only for agents)
    board/                            # kanban (shared)
      backlog/
      in-progress/
      review/
      done/
    serfs/                            # identity definitions (shared, read-only for agents)
      actor.md
      critic.md
      <spawned-serf>.md
    knowledge/                        # accumulated learning (shared, append-only)
      skills/
      patterns/
      failures/
      references/
    workspaces/                       # PER-AGENT — each agent's private state
      actor/
        .serf/
          last-state.md               # what the actor did last
          context.md                  # the actor's working context
          plan.md                     # the actor's current plan (if any)
      critic/
        .serf/
          last-state.md               # what the critic evaluated last
          calibration.md             # the critic's self-assessment history
          verdicts/                   # the critic's verdict log
      <spawned-serf>/
        .serf/
          last-state.md               # what this serf did last
          context.md
    worktrees/                        # PER-TASK — isolated checkouts
      <card-id>/                      # full repo checkout at HEAD
        .serf -> ../../                 # symlink to shared .serf/ (board, knowledge, identities)
        <agent works here>
    events/                           # audit trail (shared, append-only)
    critic/
      thresholds.md                   # agreement threshold config
```

### What's Shared vs What's Private

| Layer | Shared | Private (per-agent) | Private (per-task) |
|-------|--------|--------------------|--------------------|
| Board | ✓ | | |
| Knowledge | ✓ | | |
| Serf identities | ✓ (read-only for agents) | | |
| Events | ✓ (append-only) | | |
| Working state | | ✓ (`.serf/workspaces/<name>/`) | |
| Task output | | | ✓ (`.serf/worktrees/<card-id>/`) |

## How It Works

### When a card moves to in-progress

1. `git worktree add .serf/worktrees/<card-id> HEAD`
2. The worktree's `.serf` is symlinked to the shared `.serf/` — the agent sees the board, knowledge, and identities
3. The assigned agent's workspace is at `.serf/workspaces/<agent-name>/`
4. The agent's `cwd` is the worktree root

### When the actor works

- Reads shared `.serf/serfs/actor.md` for its identity
- Reads shared `.serf/knowledge/` for accumulated learning
- Reads shared `.serf/board/in-progress/<card-id>.md` for the task
- Writes working state to `.serf/workspaces/actor/.serf/last-state.md`
- Writes code/changes to the worktree (`.serf/worktrees/<card-id>/`)
- Writes plans to `.serf/board/in-progress/<card-id>-plan.md` (shared, so the critic can read it)

### When the critic evaluates

- Reads shared `.serf/serfs/critic.md` for its identity
- Reads shared `.serf/knowledge/failures/` for past leniencies
- Reads shared `.serf/board/in-progress/<card-id>-plan.md` for the actor's plan
- Reads the worktree output (the actor's changes)
- Writes verdicts to `.serf/workspaces/critic/.serf/verdicts/`
- Writes calibration to `.serf/workspaces/critic/.serf/calibration.md`

### When the critic passes

1. `git merge <card-id>` — the worktree's changes come into the main repo
2. `git worktree remove .serf/worktrees/<card-id>`
3. Card moves to `done/`
4. Agent updates its `last-state.md` in its workspace

### When the critic fails

1. `git worktree remove --force .serf/worktrees/<card-id>` — all changes discarded
2. Card stays in `in-progress/` or moves to `review/`
3. Agent's workspace retains its `last-state.md` (so the next attempt has context)

### When a serf is spawned

1. `createSerf()` writes identity to shared `.serf/serfs/<name>.md`
2. `mkdir .serf/workspaces/<name>/.serf/` — the spawned serf gets its own workspace
3. If herdr is running, the spawned serf gets a pane (already wired)
4. The spawned serf picks up cards from the board like any other agent

## Worktree Merges: Convergence, Not Determinism

We are not doing deterministic optimization. This is not a math problem. We are tackling an unwieldy, open-ended problem that should converge toward the simplest possible solution.

The merge is not automatic. It is a dialogue:

1. **Actor produces changes in the worktree.** Writes code, tests, docs.
2. **Critic evaluates.** Reads the diff (`git diff HEAD` in the worktree). Explores curiously. If uncertain, asks the actor. If still uncertain after dialogue, the issue bubbles to the user.
3. **If they converge (critic passes):** the merge happens. `git merge --no-ff <card-id>` — the merge commit records that this was a reviewed change.
4. **If they don't converge (critic uncertain after dialogue):** no merge. The worktree stays. The curiosity is logged to `knowledge/patterns/`. The user decides.
5. **If the critic fails the work outright:** `git worktree remove --force` — discard. The work is gone. The actor retries or a spawned serf takes over.

The merge is the convergence signal. No convergence, no merge. The worktree is the limbo state — changes exist but aren't real until the critic agrees they are.

### Research Agents for Curiosities

When the actor or critic hits a curiosity they can't resolve through dialogue, they can spawn a **research agent** with a limited budget to investigate. This is Schmidhuber's curiosity made operational: the system finds the boundary of its own knowledge and sends an agent to explore it.

The research agent:
- Gets a limited budget (small `BudgetTracker`)
- Has one job: investigate the curiosity and report back
- Writes findings to `knowledge/references/` (shared, so the next agent benefits)
- Does not modify the worktree or the board — it only researches

The actor or critic can request a research agent the same way the master spawns serfs — by writing a card to the board with a `research` tag and a budget limit.

## Serf as Boilerplate Dark Factory

Serf is not tied to a specific project. It is a boilerplate dark factory that can be put onto any project or idea — existing or emergent — and make it better, make it work, make it as simple as possible.

This means:

- `serf init` in any directory creates the factory. The project doesn't need to know about serf beforehand.
- The `.serf/` folder is self-contained. It brings its own identities (actor, critic), its own board, its own knowledge. It doesn't depend on the host project's structure.
- The agent prompts tell the agent: "Read the project you're in. Understand it. Then do the task." The factory adapts to the project, not the other way around.
- If a project already has conventions (package manager, test framework, build system), the actor reads them and follows them. The factory doesn't impose its own conventions on the project — it learns the project's conventions.
- `serf init` can be run in a subdirectory of a larger project. The `.serf/` folder wields great power within its scope — the worktree is rooted at the init point, not at the git root. This lets you apply the factory to a specific area (e.g., `docs/.serf/` for documentation, `frontend/.serf/` for frontend work) without affecting the whole repo.

### Subdirectory Initialization

When `serf init` runs in a subdirectory:
- `.serf/` is created in that directory
- The worktree is rooted at that directory, not the git root
- The agent's `cwd` is the worktree of that subdirectory
- The agent can read the full repo (it's a git worktree) but writes are scoped to the subdirectory
- This is how a factory can be put onto a part of a project without affecting the whole

### Agents Calling Other Serfs

An agent working in a subdirectory factory can call on serfs from the root factory (or any parent factory) if it needs help outside its scope. The mechanism is simple: the agent writes a card to its board requesting escalation, and the parent factory's master picks it up.

This is a hierarchy of factories, not a flat structure:
```
project-root/
  .serf/                    # root factory — handles project-wide tasks
  frontend/
    .serf/                  # frontend factory — handles frontend tasks
      board/                # can escalate to root by writing to ../.serf/board/backlog/
  backend/
    .serf/                  # backend factory — handles backend tasks
```

The interface between factories is the board. A child factory writes an escalation card to the parent's `board/backlog/`. The parent's master picks it up. No new code — just file paths.

## Transparency: The Critic Can Read the Actor's Workspace

We are not doing deterministic optimization. We are converging toward the simplest possible solution to an open-ended problem. Transparency is how convergence happens.

The critic CAN read the actor's workspace (`.serf/workspaces/actor/.serf/`). Not to police the actor, but to understand *why* the actor made certain choices. If the critic is uncertain about a change, it can read the actor's `last-state.md` and `context.md` to understand the reasoning. This is the opposite of a black-box critic that only sees output — it's a glass-box critic that sees the process.

This is also how research agents work: the research agent's findings go to `knowledge/references/` (shared), and both the actor and critic can read them to inform their convergence.

### When They Can't Converge

If the actor and critic cannot converge after dialogue:
1. The curiosity is logged to `knowledge/patterns/` with full context — what was attempted, what the critic questioned, what the actor answered, where they got stuck.
2. A research agent card is written to the board with a limited budget to investigate the specific curiosity.
3. If the research agent returns with an answer, the actor and critic retry with the new information.
4. If the research agent also can't resolve it, the issue bubbles to the user as a preference task: "We tried. We can't converge. Here's what we found. What do you prefer?"

The user is never the first resort. The user is the last resort when the system has exhausted its own ability to converge.

## Package Manager Discipline

The actor prompt gets a new section, enforced by the critic:

```
## Installation Rules
- Install dependencies only via the project's package manager (bun/npm/pip/cargo).
- Never run `curl | bash` or `wget | sh`.
- Never write to ~/.ssh, ~/.config, ~/.local, /usr/, or /opt/.
- Never install global packages. Use devDependencies or local installs only.
- If a package is missing, add it to the project manifest and install locally.
```

## Credential Security

The agent should never hold raw API keys.

**The KISS approach:** `callLLM` in `llm.ts` already runs on the host (the master process), not in the agent. The agent communicates with the host via the board (files), not via direct API calls. The host calls the LLM. This is already how direct mode works.

For herdr mode: the agent process gets a dummy or empty `ANTHROPIC_API_KEY` — the real key stays with the master process. The agent writes to files, the master reads them and calls the LLM.

No proxy needed. The folder IS the communication channel.

## Container Isolation (Future, Opt-in)

Worktrees + workspaces give us filesystem isolation within the repo. If we later need process isolation (network, syscalls, `/dev`), we add containers as an opt-in layer:

### macOS: Apple Container
https://github.com/apple/container

- Native, no Docker daemon, lightweight VMs on Apple silicon
- `container run` with only the worktree mounted
- Requires macOS 26

### Linux: Bubblewrap
https://github.com/Friz-zy/awesome-linux-containers

- `bwrap` — rootless, no daemon, Linux namespaces
- Wrap the agent launch with restricted mounts
- The lightest process isolation on Linux

### NanoClaw's Pattern
https://github.com/nanocoai/nanoclaw

- Agents run in containers, credentials never enter the container
- Each agent gets only the mounts you allow
- The container pattern is the same, just a stronger boundary

Container support is Phase 3 — only if worktrees + workspaces aren't enough. The folder structure doesn't change. The container just wraps the worktree.

## Implementation Order

### Phase 1: Per-agent workspaces (now, no dependencies)
1. `mkdir .serf/workspaces/actor/.serf/`, `.serf/workspaces/critic/.serf/` on `serf init`
2. Update `buildAgentPrompt` to tell the agent: "Your workspace is `.serf/workspaces/<your-name>/`. Write your working state there. The critic can read it for transparency."
3. Update `buildCriticAgentPrompt` to tell the critic: "Your workspace is `.serf/workspaces/critic/`. Write your verdicts and calibration there. You may read the actor's workspace at `.serf/workspaces/actor/` to understand their reasoning."
4. Update `ensureSeeded()` in `master.ts` to create workspace dirs
5. Update `serf init` in `index.ts` to create workspace dirs

### Phase 2: Git worktrees (now, no dependencies)
1. `createWorktree(card)` — `git worktree add .serf/worktrees/<card-id> HEAD`, symlink `.serf`
2. `removeWorktree(card, merge)` — `git merge --no-ff` on pass, `--force` on fail
3. Pass worktree path as `cwd` to `HerdrHarness.create` and `spawnAgent`
4. Merge on critic convergence, discard on fail, hold on uncertainty
5. Add `.serf/worktrees/` and `.serf/workspaces/*/` to `.gitignore`

### Phase 3: Research agents for curiosities (now, no dependencies)
1. When the critic is uncertain and can't converge through dialogue, write a research card to the board with a `research` tag and a limited budget
2. The master picks up research cards like any other card, but with a smaller `BudgetTracker`
3. The research agent writes findings to `knowledge/references/` (shared)
4. The actor and critic retry with the new information
5. If research can't resolve it, bubble to user as a preference task

### Phase 4: Subdirectory initialization (now, no dependencies)
1. `serf init` in a subdirectory creates a scoped `.serf/`
2. Worktrees are rooted at the init directory, not the git root
3. Agents can escalate to a parent factory by writing cards to `../.serf/board/backlog/`
4. The hierarchy is: root factory → subdirectory factories → spawned serfs

### Phase 5: Container support (future, opt-in)
1. Detect `container` (macOS) or `bwrap` (Linux) availability
2. If available: wrap the agent launch in the container/runtime
3. Herdr pane launches the container, not the agent directly
4. The container runs inside the worktree — same folder structure, stronger boundary

### Phase 6: Credential hardening
1. Strip API keys from agent process environment
2. `callLLM` runs on the host (already does in direct mode)
3. For herdr mode: the agent process gets no real keys — the master proxies LLM calls

## What Doesn't Change

- The board, knowledge, events, serf identities stay in the shared `.serf/` — that's the factory floor
- The loop logic in `master.ts` doesn't change — it just sets `cwd` to the worktree
- The critic dialogue doesn't change — both agents read the shared board, and now the critic can also read the actor's workspace
- `callLLM` doesn't change — it runs on the host
- herdr integration doesn't change — panes just launch in the worktree directory

## Questions for Discussion

1. **Merge strategy:** `--no-ff` (always create a merge commit) vs `--ff-only` (fast-forward if possible). `--no-ff` records that this was a reviewed change — the merge commit is the critic's signature. `--ff-only` is cleaner history but loses the review record. The plan proposes `--no-ff` for transparency. Discuss with the actor and critic.

2. **Research agent budget:** What's the right limit? Too small and the research is superficial. Too large and it defeats the budget tracker. Proposal: 10% of the current harvest budget, configurable in `.serf/critic/thresholds.md`.

3. **Escalation path for subdirectory factories:** When a child factory escalates to a parent, does the parent see the child's context? Proposal: the escalation card includes a `## Context` section with a summary of what the child tried. The parent doesn't read the child's `.serf/` directly — it reads the card.

4. **What about `serf init` in an existing project?** The init should detect the project's package manager, test framework, and build system, and write that to `plan.md` so the agents know the conventions. `serf init` becomes: create the factory + detect the project's conventions + write them to the plan.

## References

- Apple Container: https://github.com/apple/container
- NanoClaw (container pattern for agents): https://github.com/nanocoai/nanoclaw
- awesome-linux-containers: https://github.com/Friz-zy/awesome-linux-containers
- Git worktrees: https://git-scm.com/docs/git-worktree
- herdr `createWorktree()`: `src/v2/herdr.ts:199` (currently unused)
- Karpathy's LLM-wiki: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f — the folder IS the state. Worktrees and workspaces follow this. The worktree is disposable, the workspace is the agent's memory, the shared `.serf/` is eternal.
- Schmidhuber's curiosity: the system finds the boundary of its own knowledge and sends an agent to explore it. Research agents are this made operational.