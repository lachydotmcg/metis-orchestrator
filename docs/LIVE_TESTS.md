# LIVE TESTS — the walk-through (2026-07-16)

Everything here shipped green on `npm run build` but has never been touched in the real
Electron app. Work top to bottom; each test says exactly what to do and what you should see.
Check them off as you go, and jot anything weird next to the box — a one-word note is enough
for the next drill to act on.

Prep once: `npm run dev`, Ollama running with your usual model pulled, DeepSeek key saved in
Settings > Providers.

---

## 1. Per-model gateways (the big rework)

- [ ] **Click vs drag in the Library.** Orchestration > Library > Models tab. Click a model
  WITHOUT moving the mouse: the side panel should swap to that model's gateway panel (logo,
  name, Gateway dropdown, gateway fallbacks). Now drag a model a few pixels: the ghost drag
  should start and drop onto a node exactly like before. The boundary is 5px of travel.
- [ ] **DeepSeek shows every real route.** Click DeepSeek V4 Flash in the Library. The Gateway
  dropdown should offer Auto + DeepSeek + NVIDIA NIM + OpenRouter (this was the original bug:
  it only ever showed DeepSeek).
- [ ] **No more Grok imposter.** Click any Claude model. Gateway options should read
  Claude + OpenRouter. If you see "Grok" anywhere in a gateway list, that fix regressed.
- [ ] **Config is per-MODEL, globally.** Set DeepSeek V4 Flash's gateway to NVIDIA in the
  Library, then look at a node using it in orchestration and run a build/test — the route
  should honor NVIDIA wherever that model appears. The node inspector itself should show NO
  gateway section anymore, just a hint pointing at the Library.
- [ ] **Kimi + Llama sanity.** Kimi K2.6 should offer OpenRouter + Groq; Llama 3.3 70B should
  offer Groq + NVIDIA + OpenRouter.
- [ ] **Open-weight models gained cloud escape hatches.** gpt-oss 20B/120B and DeepSeek R1
  Distill 70B (Local tier) should list Groq/NVIDIA/OpenRouter routes after their Ollama route.
  Local must stay first: with Ollama running, a run on these should still go local.

## 2. Depths

- [ ] **L3 is your base model.** Enable depths on a node. The L3 row should show that node's
  own model with its logo and "· base" — not "Strongest cloud (default)".
- [ ] **Drag-drop follows.** With depths enabled, drag a DIFFERENT model onto the node. The L3
  row should update to the new model (give the debounce a second), inspector open or closed.
- [ ] **A heavy prompt routes deep.** Depth routing on, Auto Router, ask something genuinely
  architectural. Timeline should show the router's depth call and the run should land on your
  L3 model. A one-liner tweak should land shallow (L1 / router).

## 3. Cloud Oracle (O5) — the money one

- [ ] **The toggles gate it.** Settings > Chat > Experiments: "Cloud Oracle via DeepSeek"
  should exist with the cost warning. With it OFF and a DeepSeek model pinned, typing must
  produce ZERO DeepSeek API calls (check your DeepSeek usage dashboard if paranoid — this is
  the never-spend-silently guarantee).
- [ ] **Instant serve via the cloud.** Both toggles ON, pin DeepSeek V4 Flash, type a real
  question, pause 2+ seconds (watch the Oracle chip), then send WITHOUT editing. Expect
  "Oracle answered instantly, Xms" with a sub-second first token. Then edit one word and send:
  it should fall back to a normal call, never serve the stale draft.
- [ ] **Send never queues.** Type, pause (draft starts), then immediately send a different
  prompt. First token should NOT stall behind the speculative call.

## 4. Oracle draft streaming (I9.2) + open-prewarm (I9.1)

- [ ] **The guess forms live.** Prewarm on, pin a local model, open the Oracle chip popover,
  type and pause. The guess should STREAM into the popover word by word — thinking first if
  it's a reasoning model — instead of appearing all at once.
- [ ] **Warm before you type.** Open an existing conversation that has a pinned local model.
  The Oracle chip should flash "warming" within ~a second of the conversation opening, before
  you touch the keyboard. First keystroke response should feel warm.

## 5. MCP tools in runs (P10.2)

- [ ] **Flag surface.** Settings > MCP servers: "Let runs use MCP tools (experimental)" toggle
  exists, default off.
- [ ] **A real tool call.** Install an MCP server from the Marketplace (filesystem or fetch is
  easiest), Test-connection it, flip the toggle ON, then in chat ask something that needs the
  tool ("use the fetch tool to get example.com and summarize it"). Expect: a timeline line
  listing available MCP tools at the start, then "MCP tool X (server) returned in Nms" when it
  fires, and the answer actually using the result. Known v1 quirk: the model's raw JSON tool
  directive may briefly stream into the reply before the continuation replaces it.
- [ ] **Fail-soft.** Kill/misconfigure the server and ask again: the run should complete with
  the model told the tool failed — never a crashed run.

## 6. Headless / service mode (P10.5)

- [ ] **Toggle + relaunch.** Settings > Window: "Start minimized to tray" ON, quit fully,
  relaunch. No window should appear; the tray icon should be there; clicking it opens the
  window normally.
- [ ] **Gateway serves headless.** With the Gateway enabled too, while headless run:
  `curl http://127.0.0.1:11500/v1/models -H "Authorization: Bearer <your token>"` — it should
  answer without the window ever opening.
- [ ] **`--headless` flag.** Toggle OFF, launch with `--headless` — same hidden start.

## 7. Routines dry run (I9.4)

- [ ] **Preview without consequences.** Routines: every card should have an Eye button. Dry-run
  a build-ish routine ("tidy up the README in <project>"). Expect: spinner, then it jumps to a
  FRESH conversation showing the plan — and stops there. No files written, the routine's own
  lastRun/nextRun untouched.

## 8. Conversation forking (I9.5) + /handoff (I9.10)

- [ ] **Fork and compare.** Open a conversation with a few turns, context menu (…) > Fork. You
  should land in "<title> (fork)" with the full history and the same pinned model. Pick a
  DIFFERENT model in the fork, re-ask, compare. Delete the FORK afterward and confirm the
  ORIGINAL's turns and run metadata survive (this was the dangerous edge; it's guarded).
- [ ] **/handoff.** In a real working conversation type `/han`, pick the row. Expect a terse
  markdown brief (what/decisions/state/next steps) as a normal assistant turn you can copy.

## 9. Pipeline warm-chain (I9.3)

- [ ] **Stage 2 starts warm.** Prewarm on. Build a graph whose plan stage and frontend stage
  use two DIFFERENT local models, run a build, watch the stage handoff — stage 2's first
  token should come noticeably faster than a cold load of that model normally takes (the
  second model loads while stage 1 streams).

## 10. Knowledge provenance (I9.7)

- [ ] **Which chunks, exactly.** In a project with the knowledge bank indexed (needs
  `ollama pull nomic-embed-text`), ask a question about the project. Expand the "Grounded on
  N chunks" row: it should now list each chunk as `file #n — preview…` instead of just a
  comma-joined file list.

---

## Quick regression sweeps (5 minutes, things the rework touched)

- [ ] Dragging a NODE on the canvas still feels right (nodes now don't move until 5px of
  travel — a plain click should select without the node twitching).
- [ ] Model fallback chain add/promote/remove in the node inspector still works (promote now
  carries gateway configs with the models).
- [ ] The composer "via Provider" suffix on multi-route models reads OpenRouter/NVIDIA/Groq
  correctly (same brand fix as the gateway picker).
- [ ] A plain chat on Auto Router with every new flag OFF behaves exactly like last week —
  the whole batch is supposed to be invisible until opted into.

---

## 11. Usage tab + the ring + Oracle's glow-up (added later on 2026-07-16)

- [ ] **Usage tab exists and fills.** Settings > Usage (System group). Run a few chats first,
  then open it: window cards for last 4h / last 7d, a provider table, and a model table with a
  Cost column - local rows say "Free", cloud rows show a $ estimate from catalog list prices,
  ~ marks estimated token counts. "Provider" in the tables is the route that actually served.
- [ ] **Limits save.** Set a 4-hour limit (try something small like 20000 so you can watch it
  fill), Save limits, reopen the tab - the window card should now show "% of your 4-hour
  limit". The UI says display-only; nothing should ever throttle.
- [ ] **The ring.** With Oracle (prewarm) enabled, look beside the Oracle chip in the
  composer: a small ring. With your small 4h limit set, chat a bit - the ring should fill
  with WHITE as tokens burn (updates within a minute; hover for the exact numbers). Turn
  prewarm off: the ring disappears (BYO users never see it).
- [ ] **Oracle looks shipped.** Open the Oracle popover: wordmark header with a live status
  line, the guess in a carded block (with a blinking caret while it's still forming), a
  RECENT WARMS section, and the tagline footer. While warming, the chip should have a subtle
  shimmer sweep; when warm, a faint white halo. Nothing should flash or feel busy at idle.

## 12. Custom instructions + preference log (added later again on 2026-07-16)

- [ ] **Instructions actually apply.** Settings > Chat > Custom instructions: write something
  unmissable ("End every answer with the word BANANA."), Save, then chat on any model. The
  answer should obey. Clear the instructions, chat again - back to normal. Also confirm
  Oracle instant-serve still works WITH instructions set (type, pause, send unchanged) - the
  draft and the real run assemble the same prompt, so the hash match must survive.
- [ ] **Preference log is recording.** No UI yet by design - after a few chats run this in
  the app's devtools console: `await window.metisPreference.summary()` - expect a total > 0
  with byKind.run counting your runs. This is the learned router's raw data faucet.

## 13. Oracle v0.4 near-match serving (added 2026-07-17)

- [ ] **The cosmetic-edit serve.** Prewarm ON + the new "Oracle near-match serving" toggle ON
  (Settings > Chat > Experiments), nomic-embed-text pulled, local model pinned. Type a real
  question, pause until the guess lands, then ADD A TRAILING "please" (or fix a typo) and
  send. Expect "Oracle answered instantly, Xms - near match ~98%" - the label must show the
  percentage, never disguise it as exact.
- [ ] **The meaning-flip refusal.** Same setup, but edit the prompt to add "without React" or
  change a number before sending. It must do a NORMAL call every time - the lexical guard
  vetoes negations and numbers no matter what the embeddings say.
- [ ] **Toggle off = old behavior.** With the near-match toggle OFF, any edit (even one space)
  falls back to a normal call, exactly like v0.3.

## 14. Quick-ask + Metis as an MCP server (added 2026-07-17, gym drill)

- [ ] **Quick-ask summon.** Settings > Window > "Global quick-ask" ON, restart Metis. From any
  app (not Metis), press Ctrl+Alt+M: a small dark prompt bar should appear centered on
  your current display. Type a question, Enter: the answer streams into the overlay area (v1
  is one-shot, so it appears when done). Escape or clicking elsewhere hides it; hotkey again
  toggles. "Open Metis" should focus the main window - and the Q&A should be sitting in your
  conversation list like a normal chat.
- [ ] **Quick-ask fail-soft.** Stop Ollama, summon, ask: expect the same honest Ollama-down
  message a chat run shows, never a frozen overlay.
- [ ] **Metis as MCP server.** Gateway ON with a token. In Claude Code:
  `claude mcp add metis -e METIS_GATEWAY_TOKEN=<token> -- node <repo>\scripts\metis-mcp.mjs`
  then ask Claude to "use the metis_route tool to ask what 2+2 is". Expect the call to route
  through YOUR Metis (check the run appears in Metis's own history via the Gateway) and the
  answer to come back. metis_models should list your catalog.

## 15. Learned-router signals + observations + local cost (added 2026-07-17, gym drill)

- [ ] **Regenerate button.** Every completed answer now has a small circular-arrow button next
  to copy. Click it: the same prompt is genuinely re-asked, and Settings > Usage > "What Metis
  is noticing" should show a regenerate signal counted after a refresh.
- [ ] **Model switch signal.** Mid-conversation, switch the pinned model to a different one -
  the noticing panel's signal table should count a model_switch.
- [ ] **Observations appear.** After 10+ runs, the noticing panel should start writing
  sentences ("X answers 72% of your runs", "You pin a model on 40% of runs"). Fresh installs
  say nothing - that silence is deliberate.
- [ ] **Local electricity card.** Usage tab > Local inference cost: set your GPU watts and
  tariff, run some local chats, and the 7-day estimate should tick up from $0.00. Only runs
  from this build onward carry timing.
- [ ] **Thumbs + escape hatch.** Every completed answer has thumbs up/down next to copy - one
  vote per turn, counted in the noticing panel's signal table. And a near-match-served answer
  shows a quiet "Answer my exact prompt instead" link underneath; clicking re-asks for real.
- [ ] **Near-match v2 regression (the Test bug).** Prewarm + near-match ON. Ask a question,
  let the draft land, get the answer, then send just "Test" as the next message. It must do a
  NORMAL call - never serve the previous turn's answer (this exact case served stale in v1).

## 16. Per-conversation project folders (added 2026-07-17)

- [ ] **The haunting is over.** Open the Project context 3-dots on an EXISTING conversation:
  it should list only folders belonging to that conversation, never metis-test3 from some
  other session. Old globally-attached folders are gone by design (re-add per conversation).
- [ ] **New session starts folderless.** Start a new session: the folder chip above the prompt
  box should read "No project folder" with a + beside it. Attach one, send a message: that
  folder is now bound to that conversation.
- [ ] **Switching conversations switches folders.** Give conversation A folder metis-test4 and
  conversation B folder metis-test3, then click between them. The chip/context should follow
  the conversation each time, and a build in A must write into A's folder.
- [ ] **Mid-conversation attach binds.** In an existing conversation, use the 3-dots to choose
  a different folder. Reopen the conversation later - it should still have that folder.

## 17. Interface sound, both tiers (added 2026-07-18, docs/DRILL_PLAN.md B12.10)

Sound is off until you ask for it, so every test below starts from Settings > Appearance >
Interface sound. Do these with the room quiet and the system volume somewhere sane: the whole
tier is deliberately near the floor and you will not hear it over a fan.

**Turning it on**

- [ ] **Off is really off.** Fresh install, before touching anything: click around, hover
  everything, send a prompt. Silence, all of it. Nothing in this section should make a sound
  until the master switch is on.
- [ ] **Reduced motion is honoured, once.** If your system asks for reduced motion, the hint
  under the master switch should say so and the switch should be off. Turn it on anyway - the
  hint should change and stay changed. Your choice beats the system preference from then on.
- [ ] **The two switches nest.** With the master switch off, the "Interface clicks and hover"
  switch below it and the Volume slider should both be greyed out and unclickable, not sitting
  there looking live.
- [ ] **The sound switches themselves are silent.** Flipping either switch, in either
  direction, makes no sound. That is intentional and deterministic, not a dropped cue: the
  click that changes what sound does should not be the one thing that ignores the change.
- [ ] **Preview.** Master switch on, hit Preview. You should hear a rising three-note figure,
  and half a second later the SAME figure slowed down. That pair is the whole design: a send,
  and the answer to it. If the second one sounds like a different instrument, something is
  wrong.
- [ ] **Volume glides.** Play Preview and drag the Volume slider while it is still ringing. It
  should get quieter smoothly. Any zipper, crackle or step means the gain ramp regressed.

**The informational tier (the five cues that mean something)**

- [ ] **Send.** Type anything and hit Enter. One rising figure, once.
- [ ] **Run complete.** Let a real run finish. Same figure, slower. Now do a run that finishes
  almost instantly - that one should be SILENT. A sound for something that felt instant is
  noise, so anything under 1.5s is dropped on purpose.
- [ ] **Run failed.** Stop Ollama and send something. Two neighbouring tones rubbing against
  each other - rough, not a beep. Cancelling a run yourself must NOT play this.
- [ ] **Delete armed, then committed.** Arm a delete (conversation 3-dots, a gallery image, a
  board). First click: a dull, dark tone with nothing bright in it. Second click: lower,
  shorter, final. These two must not sound like the click tier.
- [ ] **No smearing on retrigger.** Send several prompts quickly. Each new figure should duck
  the one still ringing rather than piling up into a loud mush.

**The click and hover tier**

- [ ] **Sub-toggle gates BOTH.** Turn "Interface clicks and hover" off (master still on).
  Clicking and hovering go silent while sends and run-completes still sound. Turn it back on
  and both return.
- [ ] **Buttons tick.** Click ordinary buttons around the app: a short, quiet tick, same
  instrument as the big cues, about a third of the weight.
- [ ] **Toggles rise and fall.** Any toggle that is not a sound toggle (Settings > General >
  Close to tray, say). Switching ON rises, switching OFF falls. If they are backwards, the
  capture-phase pre-click read regressed and this is the test that catches it.
- [ ] **Nav is lighter.** Click between sidebar sections and settings tabs: a higher, drier
  tick than a button. Moving between places should feel lighter than committing to something.
- [ ] **Menus open and close.** The permission pill above the composer. Opening leaps up an
  octave, closing leaps back down. Click the pill again to close it - the fall is the test.
- [ ] **Hover has no note.** Hover a button or a sidebar row. You should hear the contact
  sound only - a tiny tick with no pitch. If you can hum it, `contactOnly` regressed.
- [ ] **First hover after launch is silent.** Expected, not a bug. Hover cannot open the audio
  engine on its own (a mouse move is not a user gesture, so the browser would hand back a
  suspended context). Click something first, then hover works for the rest of the session.

**One action, one sound**

- [ ] **Send does not double.** Click the send BUTTON with the mouse rather than pressing
  Enter. You should hear the send figure and nothing stacked on top of it. Before this fix the
  button ticked and then sent, two sounds for one action.
- [ ] **Delete does not double.** Same check on an arm/commit delete: exactly one sound per
  click, and it should be the dark one, never a bright tick over it.
- [ ] **Preview does not double.** Hit Preview: the send/answer pair only, no button tick.
- [ ] **Stop is not a send.** Start a long run and clear the composer so the button becomes
  the square stop button. Click it. You should hear the NEUTRAL click, never the send tone -
  the abort and the send must never be confusable, and that button carries both class names.
- [ ] **A menu opening under the cursor does not tick.** Click something that opens a popover
  right under your pointer and then hold still. One sound (the click), not a click followed by
  a hover tick as the new elements appear beneath you.

**The typing-silence guarantee**

- [ ] **The composer is silent.** Click into the prompt box, type a paragraph, select text with
  the mouse, drag the selection, click the box again. Not one sound at any point. This is the
  most-used surface in the app and the one that has to be perfect.
- [ ] **Settings fields are silent.** Click into the custom-instructions textarea, an API key
  field, any text input. Silent. Drag the Volume slider itself end to end: silent (it is a
  field, and a tick per step would be unbearable).
- [ ] **Dragging is silent.** In Orchestration, drag a graph node around the canvas and drop
  it. No sound. A drag that ends where it started fires a click event, so this is a real trap -
  the boundary is 6px of travel, same idea as the 5px click-vs-drag rule in the Library.
- [ ] **Keyboard activation still counts.** Tab to a button and press Enter or Space. That
  SHOULD tick - it is a deliberate activation, just not with a mouse.

**The fast-sweep test (the one that proves it is not a machine gun)**

- [ ] **Run down the conversation list.** Sidebar with a good number of conversations. Drag the
  pointer from top to bottom as fast as you can. You should hear about four ticks in the first
  third of a second and then roughly one every third of a second for the rest of the sweep -
  never one per row, and never a rattle.
- [ ] **Sweep the model picker.** Same again across the router option rows. Same behaviour.
- [ ] **Sweep and click.** Sweep a list, then immediately click a row. The click should still
  sound at full weight: the click tier keeps a reserve the hover tier cannot spend.
- [ ] **Sweep during a run.** Machine-gun the sidebar while a run is finishing. The run-complete
  cue must still land. If drumming on the interface can swallow it, the tier floors regressed.
- [ ] **Wiggle inside one row.** Hold the pointer inside a single row and jiggle it over the
  icon, the text and the buttons inside it. Crossing into a nested button may tick once, but
  jiggling within the same control must not tick repeatedly.
