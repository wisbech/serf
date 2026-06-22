# Serf Wiki

The knowledge base for the serf agent harness. Topics are organized by domain.

## Topics

| Topic | Description |
|-------|-------------|
| [skill-crystallization](./topics/skill-crystallization.md) | How skills are auto-extracted from successful harvests |
| [harvest-quality](./topics/harvest-quality.md) | How harvests are scored and graded |
| [tmux-architecture](./topics/tmux-architecture.md) | How tmux sessions form the serf substrate |
| [swarm-intelligence](./topics/swarm-intelligence.md) | Ant-colony knowledge sharing between serfs |

## Quick Reference

### Commands
```bash
serf launch pi --backend ollama  # Start pioneer
serf harvest "task"              # Run harvest
serf list                         # List serfs
serf metrics                      # Show metrics
```

### Files
- `src/harvest.ts` — Core harvest loop
- `src/domain/skill/` — Skill system
- `src/domain/harvest/` — Quality scoring
- `~/.serf/` — Runtime state

## Links

- [PLAN.md](../PLAN.md) — Roadmap and execution plan
- [AGENTS.md](./AGENTS.md) — Agent guidance