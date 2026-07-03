# Metis Orchestrator Handoff

## Product Boundary

Metis Orchestrator is the desktop app/runtime. It should not benchmark models and
should not own routing logic. It consumes Metis Policy decisions and executes
them.

## First Product Goal

Build an orchestration app where the user can:

- see the orchestration tree as the default surface
- edit router, skill, and model nodes directly on the graph
- save and load orchestration presets
- test a route before using it in a real conversation
- later inspect project logs through a separate Obsidian-style Graph View

## Current Scaffold

The scaffold is a React renderer inside Electron. The UI direction has shifted
from a chat-first shell to an orchestration-first graph canvas. Current graph
work is visual/prototyping code until real `metis-policy` integration lands.

For the current design backlog, read `docs/NEXT_STEPS.md` first.

## Do Next

1. Stabilize the graph editor interactions.
2. Remove unused navigation such as Chat/Code and Dispatch.
3. Add project-folder conversations/log views.
4. Add preset save/load.
5. Add Test Route.
6. Build the separate Graph View for logs, context, and token optimization.
7. Connect persisted graph edits to Metis Policy overrides.

## Hard Rules

- Keep Benchmark, Policy, and Orchestrator separate.
- Do not route prompts silently without an inspectable reason.
- Do not store raw prompts remotely by default.
- Do not imply local models are only cheap fallbacks.
- Do not begin billing/subscription logic before provider/account boundaries are
  explicit.
