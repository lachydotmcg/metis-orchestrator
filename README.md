# Metis Orchestrator

Electron desktop app for the Metis orchestration layer.

Metis has three separate products:

1. **Metis Benchmark** measures model quality, hardware behavior, speed, cost,
   and failure modes.
2. **Metis Policy** turns benchmark evidence into explainable route decisions.
3. **Metis Orchestrator** executes those route decisions in a desktop app.

This repo is layer 3. It should consume the `RouteDecision` contract from
`metis-policy`, not invent hidden routing logic inside the UI.

## Current Slice

This first scaffold includes:

- Electron + React + TypeScript
- chat-style product shell
- router/model selector beside the send button
- route explanation panel
- evidence and score breakdown
- top-left policy graph view
- sample `RouteDecision` data shaped like `metis-policy` v0.1

It does **not** call real models yet. It does **not** manage billing yet. It does
**not** upload prompts. The current goal is to prove the app shape against the
policy contract.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

Build:

```powershell
npm.cmd run build
```

## Next Integration

1. Load a real `profile.json` and `decision.json` from `metis-policy`.
2. Add a provider setup screen for BYOK and paid router access.
3. Add an Ollama connector for local inference.
4. Wire the chat send action to:
   - classify prompt through policy
   - show the selected route
   - call the selected model/provider
   - display the answer
   - preserve the explanation trail
5. Make the policy graph editable and persist user overrides.
