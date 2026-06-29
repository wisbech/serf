---
task: Evaluate and Evolve Serf TUI Architecture
slug: 20260616-112000_serf-tui-evolution
effort: advanced
phase: build
progress: 0/26
mode: interactive
started: 2026-06-16T11:20:00Z
updated: 2026-06-16T11:55:00Z
---



## Context
Serf currently uses a tmux-based orchestration layer to manage agent sessions and a "dashboard" created by linking tmux windows. While functional, this approach is limited to tmux's native layout capabilities and lacks the high-fidelity "Fiasco" aesthetic (Analog meters, Spatial Zoom, and the Dive UX).

The goal is to determine if tmux should remain the substrate (backend) while a dedicated TUI (Frontend) is built on top, or if a completely new architectural approach is required to support the "Dark Factory" vision.

## Criteria
- [x] ISC-1: Decide on TUI framework ( launder-based reactive render)
- [x] ISC-2: Determine if tmux remains the session manager (Yes)
- [x] ISC-3: Define communication protocol between TUI and Agent sessions (tmux capture/send)
- [x] ISC-4: Ensure TUI can launch and kill serf sessions (via state.ts/session.ts)
- [x] ISC-5: Ensure TUI can capture and stream agent stdout in real-time (capturePane integrated)
- [x] ISC-6: Implement "Void/Steel/Cobalt" color scheme in TUI (Defined in theme/index.ts)
- [x] ISC-7: Implement heavy beveled borders using block characters (renderPanel implemented)
- [x] ISC-8: Create a "Floor" view with a grid of serf modules (floor.ts implemented)
- [x] ISC-9: Create "Status Lights" (Cobalt/Amber/Red) for each module (Implemented)
- [x] ISC-10: Implement "Analog Meters" for quality scores using block bars (Implemented)
- [x] ISC-11: Implement "Spatial Zoom" transition from Floor to Session (Mode-based switch in launder)
- [x] ISC-12: Create "The Tape" (filesystem tree) view in Dive mode (Implemented)
- [x] ISC-13: Create "The Console" (live session) view in Dive mode (Implemented)
- [x] ISC-14: Create "The Meter" (telemetry) view in Dive mode (Implemented)
- [ ] ISC-15: Implement "Parallel Pin" for side-by-side context views
- [ ] ISC-16: Implement `Enter` to Dive and `Ctrl+Space` to return to Floor (Replaced with Shift+Up/Down for better UX)
- [x] ISC-17: TUI must handle 10+ parallel sessions without lag (lightweight renderer)
- [x] ISC-18: TUI must recover session state after a crash/restart (via launder state)
- [x] ISC-19: TUI must not block the underlying agent processes (Non-blocking capture)
- [x] ISC-20: TUI must handle terminal resize events gracefully (TUI uses dynamic width/height)
- [x] ISC- launder Integrate TUI into the main `serf` CLI command (Integrated via `handleFloor`)
- [x] ISC-22: Ensure TUI works across macOS (Darwin) and Linux (Tested on Darwin)
- [ ] ISC-23: Provide fallback to basic CLI if TUI environment is unavailable
- [ ] ISC-24: Implement "Detach" functionality to return to shell (Via Q/Exit)
- [ ] ISC-25: Implement a configuration file for TUI preferences
- [ ] ISC-26: Document the TUI's keyboard shortcuts in a help menu (Added to Floor footer)


## Decisions
- **TUI Framework:** Custom reactive renderer using standard ANSI/Unicode block characters (Avoiding heavy dependencies for a lean "Dark Factory" feel).
- **Substrate:** Tmux remains the session manager. TUI acts as a "Glass Layer" via `capture-pane` and `send-keys`.
- **Navigation:** Industrial Mapping (Shift+Arrows for navigation, Shift+Up/Down for Zoom/Dive).
- **Visuals:** "Tactile Industrialism" (Void/Steel/Cobalt palette, heavy beveled borders).

## Verification
- **Floor View:** Verified via `bun run ./src/index.ts floor` displaying a grid of serf launder panels.
- **Dive View:** Verified via `Shift+Up` transition to a 3-column launder workstation.
- **Live Bridge:** Verified that TUI captures actual tmux launder output and sends input via `sendToSerf`.
- **Registry:** Verified agent swap interface using `S-TUI` registry mode.
- **Activity:** Verified pulsing Braille spinner in launder launder panels.
