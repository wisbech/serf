# Serf Hierarchy — Federated State & Publication Contract

> Status: proposal (pre-implementation)
> Date: 2026-09-06

## 1. The problem

Serf today is a single `.serf/` folder in one project. It works, but it can't express:

- **Multiple serfs with their own private state** (departments, not one shared folder)
- **A hierarchy** (a serf managing subordinate serfs)
- **Selective sharing** (publish a balance sheet, keep transactions private)
- **Cross-machine operation** (serfs on different hosts)

The current event bus (`serf emit` + subscriptions) is a *local* notification mechanism that conflates state with notification, and it doesn't cross a boundary.

## 2. The model

Each serf owns a **private state folder** and **publishes a curated subset** to a public surface. Downstream serfs read only the published subset.

```
Accounting serf                    Management serf
├── .serf/ (private)               ├── .serf/ (private)
│   ├── transactions/  ← raw       │   ├── decisions/
│   ├── ledgers/                   │   └── ...
│   └── ...                        │
└── publishes →                    └── reads ←
    balance-sheet.md                   balance-sheet.md
    monthly-statement.md               monthly-statement.md
```

The hierarchy is just the direction of the publish/read edges. A serf that publishes to a parent is a subordinate; a serf that reads from children is a manager.

## 3. Three operations, cleanly separated

| Operation | Direction | Mechanism | Transport |
|---|---|---|---|
| **Publish** | producer → many | push + fan-out | message/event (local) or A2A/webhook (remote) |
| **Subscribe** | consumer declares interest | push delivery | same transport |
| **Inspect** | master → one serf, on demand | request/response | direct call |

Key distinction: **subscription is push, inspection is pull.** Master "looking into something" is a one-off request, not a subscription.

## 4. The serf identity contract

A serf's identity (`serfs/*.md`) declares its boundaries:

```markdown
# accounting

## Mission
...

## Publishes
- balance-sheet.md      → parent
- monthly-statement.md  → parent

## Subscribes
- budget-targets.md     ← parent

## Inspects
- transactions/         (on demand, by master)
```

- **Publishes** — artifacts this serf makes available to its parent(s)
- **Subscribes** — artifacts this serf consumes from its parent(s)
- **Inspects** — private data a serf exposes only on explicit request

## 5. Publication is push, not file-watch

File-watch is a **pull** mechanism and is wrong for publication:

1. It breaks encapsulation (subscriber needs a filesystem handle on the producer's private folder)
2. It scales as N×M (a watcher per edge)
3. It doesn't cross machines

Publication is a **push**: the producer writes the artifact, then **announces** it (a reference, not the artifact). Fan-out handles multiple subscribers naturally.

File-watch remains correct for **one thing only**: a serf watching *its own* folder for internal changes (e.g. a new card in its own board).

## 6. The notification transport interface

The contract is transport-agnostic. The transport is pluggable:

```ts
interface NotificationTransport {
  publish(artifact: ArtifactRef, targets: string[]): Promise<void>;
  subscribe(artifact: string, handler: (ref: ArtifactRef) => void): () => void;
  inspect(serf: string, path: string): Promise<ArtifactRef>;
}
```

Implementations:

| Transport | When |
|---|---|
| `LocalTransport` | same machine — in-process event bus or local socket |
| `A2ATransport` | cross-machine — A2A protocol |
| `WebhookTransport` | cross-machine — HTTP push |
| `QueueTransport` | cross-machine — durable queue |

Same contract, different wire. This is what makes serf scale from "one project" to "departments on different machines."

## 7. How it maps to what exists

| Existing serf concept | Becomes |
|---|---|
| `.serf/` folder | the serf's **private** state |
| `serfs/*.md` identity | + `Publishes` / `Subscribes` / `Inspects` |
| `serf emit` / subscriptions | the **publish** action (write + announce) |
| `knowledge/` | the serf's private memory |
| board | the serf's private work queue |

This is a **naming and boundary clarification** on top of what exists, not a rewrite.

## 8. Migration steps

1. Add `Publishes` / `Subscribes` / `Inspects` to the serf identity schema (backward-compatible — optional fields)
2. Introduce `NotificationTransport` interface with `LocalTransport` as the default
3. Replace `serf emit` + subscription matching with `publish()` (write + announce)
4. Remove the `setInterval` polling fallbacks (replace with the transport)
5. Add `A2ATransport` as the first cross-machine implementation
6. Document the hierarchy model in `SERF.md`

## 9. Open questions

1. **Artifact addressing** — how does a serf name a published artifact? (path? URI? `serf://accounting/balance-sheet.md`?)
2. **Discovery** — how does a parent discover a child's published artifacts? (registry? convention?)
3. **Versioning** — do published artifacts carry a version/sequence for ordering?
4. **Auth** — how is "who may inspect what" enforced across machines?
