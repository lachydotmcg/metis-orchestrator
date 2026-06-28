# Metis Orchestrator Handoff

## Product Boundary

Metis Orchestrator is the desktop app/runtime. It should not benchmark models and
should not own routing logic. It consumes Metis Policy decisions and executes
them.

## First Product Goal

Build a chat app where the user can:

- type a prompt
- choose a router preset or manual model near the send button
- see which route the policy selected
- inspect why the route was selected
- open a policy graph from the top-left control
- later edit routing branches like "frontend design -> Claude Sonnet 4.6"

## Current Scaffold

The scaffold is a React renderer inside Electron. It uses sample policy data
until real `metis-policy` integration lands.

The UI should stay clear that routing is evidence-backed:

- selected route
- confidence
- fallback
- evidence citations
- warnings
- score components

## Do Next

1. Add file import for `profile.json` / `decision.json`.
2. Call `metis-policy decide` from the app or consume the policy package once it
   is published.
3. Add provider settings:
   - BYOK Anthropic/OpenAI/Gemini/OpenRouter
   - paid Metis router account placeholder
   - local Ollama runtime status
4. Add actual local Ollama message execution.
5. Add OpenRouter/cloud execution only after explicit user configuration.
6. Persist policy graph edits as user overrides.

## Hard Rules

- Keep Benchmark, Policy, and Orchestrator separate.
- Do not route prompts silently without an inspectable reason.
- Do not store raw prompts remotely by default.
- Do not imply local models are only cheap fallbacks.
- Do not begin billing/subscription logic before provider/account boundaries are
  explicit.
