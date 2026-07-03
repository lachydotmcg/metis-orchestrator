# Metis Manager — design direction (draft for Lachy to react to)

Status: **proposal, not built.** You said "no doc yet, let's define it together," so this
is the strawman. Mark up / reply and I'll build to it. Nothing here is locked.

## What it is

The Manager is **Jarvis, living inside Metis** — the in-app version of the
[ai-command-center](../../ai-command-center/README.md) orchestrator. ACC's Jarvis
runs a fleet of agents from Discord: morning briefings, client work, lead triage,
working the to-do list, provider rotation, scheduled ticks. The Metis Manager is the
same idea, but its "channels" are the surfaces Metis already has, and you talk to it
through an always-available chat widget instead of (or as well as) Discord.

**One-liner:** the Manager is the assistant that *operates Metis for you* — it reads
the orchestration graph, works the To-Do board, runs Routines, and explains/repairs
routes, using Graph View as its memory.

## The rule that keeps everything else meaningful

You flagged the risk of the Manager making other tabs pointless. The guardrail:

> **The Manager doesn't replace the other surfaces — it drives them.**
> Every action it takes lands in an existing surface you can see and edit. It never
> has hidden state.

Concretely it maps onto what already exists:

| Manager does | Lands in (existing surface) |
|---|---|
| Plans / tracks work, turns failures into tasks | **To-Do board** (already built, persisted) |
| Schedules recurring upkeep ("manager tick") | **Routines / Schedules** |
| Chooses / edits / repairs routes | **Orchestration** graph |
| Remembers projects, conversations, decisions | **Graph View** (linked memory) |
| Picks provider, handles fallback/rotation | **Metis Policy** (the router) |
| Briefs you, surfaces what changed | **Newspaper / Home feed** |

So the Manager is a *layer that acts through* Orchestration, Routines, To-Do, Graph
View — not a parallel universe. If it adds a task, it shows up on the board. If it
reschedules a routine, you see it in Routines. That keeps every tab earning its place.

## The widget (build this first — you asked for it)

A **collapsible, draggable, expandable floating window**, always reachable regardless
of which tab you're on:

- **Collapsed**: a small floating launcher in a corner (this is where the **8-bit
  companion** lives later — an animated sprite that idles, reacts, and "works" during
  a manager tick).
- **Open (default)**: a compact chat panel — talk to the Manager, it replies, and any
  actions render as small inline cards ("Added 2 tasks to *To do*", "Rescheduled
  *Daily digest*", "Routed via DeepSeek — here's the trace").
- **Expanded**: grows into a full panel / takes over the workspace for a richer
  cockpit (agent roster, tick log, pending approvals) — your "whole lotta ideas" space.
- Drag to reposition; position + collapsed/expanded state persisted.

v1 scope (what I'd build next): the floating widget shell with the three states +
drag + persistence + a basic chat thread wired to a route (reuses the session run
path). No real "managing" yet — just the container and conversation, so the companion
has a home. Everything below is phased after that.

## Phasing

1. **Widget shell** — floating, drag, collapse/expand, persisted, basic chat. *(next)*
2. **Acts on the board** — "add a task", "what's left", "mark X done" → real To-Do mutations.
3. **Explains routes** — "why did this go to DeepSeek?" reads the live graph + last run.
4. **Manager tick** — a Routine that runs a briefing into the Newspaper/Home feed.
5. **Specialist subagents + roster** — the ACC fleet model, in-app.
6. **8-bit companion** — sprite states (idle / thinking / working / done) on the launcher.
7. **External channels** (Discord/Telegram/email) — security-sensitive, last, opt-in.

## Answers from Lachy (2026-06-29)

1. **Companion / sprite art** — not now; ship the launcher with a placeholder, swap later.
2. **Acts directly vs approve** — **permission-based**: behaviour is gated by the
   permission level you give it in the widget/Settings (low = propose-then-approve,
   higher = acts directly). Reuse the existing permission-level pattern.
3. **Relationship to ACC's Jarvis** — it's **its own in-app assistant**, with *future*
   external integrations (Telegram, Discord, Slack). Don't wire to the ACC server now.
4. **Widget size** — fairly small: roughly the **width of the Library rail (~300px)**
   and about **1/3 the window height**. Collapsible/expandable from there.

— Build deferred until core is solid (Lachy wants to nail core architecture first).
