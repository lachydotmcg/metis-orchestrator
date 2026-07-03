# Metis Orchestrator — UI / Backend split

Working agreement: **Claude owns the visual/UX layer, Codex owns backend plumbing
and boilerplate.** This doc tracks who does what so the two passes don't collide.

Last UI pass: 2026-06-29 (Claude).

---

## Done in the last Claude UI pass

All in `src/renderer/styles.css` + `src/renderer/ui/App.tsx`.

- **Palette consolidated.** New neutral scale in `:root` (`--frame`, `--bg`,
  `--surface-2`, `--canvas`, `--sidebar`, `--line`, `--hover`, `--active`, ...).
  Replaced scattered one-off grays/blues (`#303030`, `#262626`, `#343946`,
  `#0d1017`, `#293140`, ...) with tokens so the app reads as one scheme.
- **Seam fixed.** The abrupt sidebar(#202020) -> near-black(#050608) edge is gone.
  The workspace column now floats as a rounded inset panel (`--radius-panel`)
  with the frame color showing as a thin gutter — the "rounded corner + lighter
  frame" look from the Claude reference. See `.metis-shell > *:not(.sidebar)`.
- **Sidebar slimmed + de-bolded.** 282px -> 252px; dropped the 800-weight
  hammer on New session / account / project rows / Pinned down to 550-600.
- **Account row always reachable.** Wrapped the middle of the sidebar in
  `.sidebar-scroll` (flex + overflow), so the account/settings row stays pinned
  to the bottom even when the window is short/minimized (was getting clipped).
- **`More` disclosure** on the primary nav (collapses Gallery / Graph / Benchmark).
- **Filter affordance** on Project folders (slider icon -> inline filter input).
- **Custom `<Select>` component** (`CustomSelect` in App.tsx) replacing native
  `<select>` popups in Settings (router preset, prompt storage, API access) and
  the Benchmark GPU picker. Styled menu, hint text, keyboard Escape, click-out.

---

## Round 2 (Claude, 2026-06-29 pt.2)

- **Scroll bug fixed.** The round-1 framing set `height:auto` on the workspace
  panel, which broke the definite-height chain the inner `overflow:auto` regions
  rely on — the chat feed grew past the viewport with nothing to scroll. Restored
  definite height and converted panel `100dvh` -> `100%`.
- **Black gutter removed.** The shell background now matches the sidebar and the
  panel is flush to the window with only its left corners rounded against the
  sidebar — no purposeless black border.
- **Sidebar placeholders removed** ("No stored project conversations yet.",
  "Pin conversations once real sessions exist."). Pinned section hides entirely
  when empty.
- **Account/profile menu redesigned** to the Claude layout: email header,
  grouped items (Settings w/ Ctrl, · Language · Get help // GitHub repo ·
  View changelog // Log out). **GitHub repo** opens
  `https://github.com/lachydotmcg/metis-orchestrator` via `metisShell.openExternal`.
- **Frameless custom titlebar DONE.** `main.ts` window is now `frame: false`
  (native File/Edit/View/Help menu + "Metis Orchestrator" title gone). Added a
  slim 34px draggable `.titlebar` with custom minimize/maximize/close, wired over
  new `metis-window:*` IPC + `metisWindow` preload bridge. Left side is empty drag
  region reserved for the future Home/News button. **Needs an Electron eyeball**
  (can't render frameless in the Vite preview).

## Claude UI backlog (next visual passes)

1. **Roll `CustomSelect` out to the remaining native selects** — the graph
   inspector primary-model + fallback pickers (App.tsx ~3700) still use native
   `<select>` with optgroups. Needs an optgroup-aware variant.
3. **Probe / pipeline visualization** (depends on Codex backlog #1 telemetry).
   When `runLabExperiment` returns real `metrics` + `graph nodes/edges` + route
   detail, render it as an actual pipeline trace (router -> chosen model ->
   fallbacks) with latency, token proxy, and evidence/warnings — not a sentence.
   Placeholder lives in the Lab result area (App.tsx ~2300-2440).
4. **Finish neutralizing blue-tinted leftovers** across the graph inspector /
   marketplace / benchmark cards (search styles.css for `#0f`, `#1a1f`, `#29`,
   `#33` hexes with a blue cast) and move them onto the tokens.

## Conversation should be a TIMELINE (Codex — needs ordered run events)

Lachy wants the assistant turn rendered as a chronological timeline, like Claude
Code / Codex tool-use: **assistant text → skill/route action (expandable box) →
assistant text** ("…then you respond again and say all good to go, underneath the
loaded-a-skill thing"). Right now a `SessionRun` is one `assistantText` blob + a
`steps[]` array, so the renderer can only show `text` then the route box. To get
true interleaving, `runSession` should emit an **ordered list of turn events**
(e.g. `{kind:"text", content} | {kind:"route", steps[]} | {kind:"text", content}`)
instead of one text + a detached steps array. The renderer already collapses the
route box to plain numbered labels; it just needs the events in order to place text
before AND after it. Claude builds the timeline renderer once the events exist.

## Codex backend / boilerplate backlog

1. **The session response is unusable — fix the formatting FIRST.** Sending
   "Hello" returns a wall of duplicated route-trace prose: the pipeline steps
   ("Route through Metis Policy", "Run General Assistant Pipeline", ...), then a
   "Selected route" block, then the route narration *repeated inline*, then the
   actual model reply buried mid-paragraph, then a trailing
   "general_chat quality for qwen3:8b uses proxy evidence from reasoning." line.
   Look at `runSession` / the assistant-turn assembly in `src/electron/main.ts`.
   Target: the turn body is **just the model's reply**. The route trace
   (provider/model, pipeline, latency, evidence) is **structured metadata on the
   turn**, not concatenated prose — Claude renders it as a small collapsed
   "route" chip/disclosure under the message. Drop the proxy-evidence sentence
   from user-facing text entirely (keep it in the audit record if useful).
2. **Probe telemetry.** `runLabExperiment` should return structured runtime data
   (route decision, chosen provider/model, fallback reason,
   policy/provider/total latency, prompt+output token proxy, evidence/warnings,
   pipeline `nodes`/`edges`) per `src/shared/runtime-contracts.ts`. Claude renders it.
3. **New session should move to Conversations on send** (user request). Today
   `NewSessionWorkspace` keeps the conversation in local component state, so it
   "stays in New session." Needed: persist the conversation (the
   `metisConversations` store is already seeded), lift/raise it so the App
   sidebar's conversation list shows it, and switch the main view to a
   conversation view (the New session home should reset for the next prompt).
   This is the same surface as #1 — do them together. Claude will style the
   conversation view + sidebar rows once the store/lifecycle is solid.
4. **Underlying structure for Routines / schedules** (demo data + persistence).
5. The redundant **"Local" chip** in New session looks already removed (none
   found in the composer).

## Codex Status Update (2026-06-29)

Backend/functionality work completed after the backlog above:

- `runSession` no longer writes route narration into the assistant reply.
  `assistantText` is now only the live provider answer, or a short no-live-answer
  fallback. Route, provider, pipeline, warning, and project data stay structured
  on `SessionRun`.
- `CompletedRun` now renders the answer first and puts the route details in a
  `Route trace` disclosure. Claude should style this as a compact chip/detail
  under the message and should not put trace prose back into the answer body.
- `runLabExperiment` now returns route metadata, metrics, pipeline nodes, and
  pipeline edges, but the separate renderer Lab tab was removed after user
  feedback because it duplicated node-level testing. Keep future test UI inside
  the selected agent/node route surface unless there is a genuinely distinct
  benchmark/lab product need.
- Clicking New Session remounts a clean composer and no longer loads the last
  three `sessionRuns` as fake current conversation history.
- Session runs append to `metisConversations`, so the sidebar can populate from
  real stored conversations instead of fake pinned/project data.

Claude UI tasks from the latest user feedback:

1. Polish the right Library panel so it visually matches the rounded app shell.
2. Eyeball the collapsed New Session icon button; Codex made it a 34px icon
   control, but it still needs final visual tuning.
3. Style `Route trace` in the conversation surface as compact metadata under
   the actual assistant answer.
4. Make node-level `Run test` feel like the real Orchestration process: router
   -> policy -> selected model -> verifier/fallback, with latency and evidence.
5. Design the normal project-scoped conversation view using real
   `ConversationRecord`s.
6. Keep account/settings visual work in Claude's lane; backend/provider/settings
   IPC contracts already exist.
7. Chat routing UX rule from user feedback: casual messages such as "Hi" should
   not visibly show a full route/pipeline ceremony. The assistant should answer
   normally first. Show route UI only when a prompt needs non-general
   orchestration, project tools, verification, fallback, or user-requested route
   inspection. Codex added a basic suppression rule; Claude should design the
   final compact route UI for the cases where it is actually useful.

Orchestration product principle: the important claim is not "the router wrote a
better sentence." The claim is that orchestration can outperform a single raw
model by making the process inspectable and configurable: classify the task,
pick a specialist route, attach relevant skills/context, verify or critique,
fallback on weakness, and log evidence. The UI should let users experiment with
that process like benchmarkers experiment with models.

## Proposed flow: merge "Test route" + "Lab probe" (design, for discussion)

User feels the two are redundant inside Orchestration. They are: **Test route**
runs a sample prompt through the graph (currently a visual pulse), and the
**Lab "live probe"** button fires `runLabExperiment`. Recommendation — collapse
them into ONE concept, **"Test run"**:

- A single slide-up **Test run drawer** docked at the bottom of Orchestration
  (not two separate buttons). One input: a sample prompt. One action: Run.
- On run it executes the *currently selected orchestration* and renders the
  pipeline trace inline: router decision -> chosen model -> fallbacks, with
  latency + token proxy + evidence/warnings (this is exactly the probe-viz from
  Claude backlog, reused).
- Kill the standalone "Lab / live probe" button; the Lab *is* the result surface
  of a Test run. "Test route" becomes "Test run" and owns this drawer.
- Result of a Test run can optionally be saved as graph memory / promoted to a
  real session.

Claude can build the drawer + trace UI; Codex provides the run + telemetry
(backlog #2). Flag if you'd rather keep them separate.

## Hard boundaries (unchanged)

- Benchmark measures models/hardware. Policy decides routes. Orchestrator
  edits/visualizes/executes. Keep them separate.
- No uninspectable routing. No remote raw-prompt storage by default.

## Codex Status Update (2026-06-29, follow-up)

- Window bar now follows the requested order: nav, search, orchestration, news.
- Library model cards now expose provider connection state: local runtime,
  API connected, needs API key, or unknown in browser-only preview.
- The fallback model control in node settings is no longer a raw select. It is
  a logo/name picker using the same model library vocabulary as the Library.
- Routines / Schedules and Manager now have first-pass product pages like To Do.
  Claude can polish visual hierarchy, but the navigation targets exist.
- Next UI polish: make the Manager feel like a persistent in-app assistant
  without forcing visible route ceremony for casual chat. The route UI should
  appear when it adds evidence, control, fallback, verification, or debugging.
