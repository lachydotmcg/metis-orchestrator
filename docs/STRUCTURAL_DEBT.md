# Structural debt

Five things wrong with the shape of this project rather than with any feature in
it. Written 2026-08-20, after a session that spent most of its time working
around item 1 rather than on the task it was given.

Every number here was measured, not estimated. Re-measure before trusting them;
the commands are given so you can.

Ordered by what unblocks what. Item 1 makes 2, 4 and 5 cheaper and every one of
them is more expensive while it stands.

---

## The measurement

```bash
find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head -5
```

| | Lines | Share of `src` |
| --- | --- | --- |
| `src/renderer/ui/App.tsx` | 18,443 | 42% |
| `src/electron/main.ts` | 15,478 | 35% |
| everything else (30+ files) | 9,781 | 23% |
| **total** | **43,702** | |

On disk: `App.tsx` is 874 KB, `main.ts` is 742 KB.

---

## 1. 78% of the source is in two files

**Status:** open. Nothing started.

**Why it is first.** It is not tidiness. It is the constraint that produced the
question "would you run Metis on this repository?" and the answer "no".

The build pipeline asks models for COMPLETE files — `Return COMPLETE files, not
snippets` is in the front-end stage prompt verbatim — and `writeGeneratedFileSet`
overwrites whole files. No model returns a 742 KB file complete. It returns
something plausible, well-formed, and a tenth of the length. That is why
`shared/write-guard.ts` had to exist (2864d8e): a guard whose entire job is to
refuse a write that these two files make inevitable.

So Metis cannot work on Metis, and the reason is the file layout, not the model.

Second cost, paid all session: these files cannot be READ, only grepped. Every
change is made without seeing the surrounding code. That is how the benchmark cut
passed a source assertion while the button stayed in the sidebar (c80ce83), and
how `runStream` briefly became a silent no-op (106e9ab).

**Done looks like:** no file in `src` over ~2,000 lines, and `main.ts` reduced to
app lifecycle plus IPC registration that delegates.

**First cut, chosen because it has the cleanest seam:** `gateway.ts`. The gateway
is already a self-contained unit — `handleGatewayRequest`, the models/chat/loops
routes, `handleGatewayBridgeRead`, the two dispatch tables, `startGateway`,
`readOrCreateGatewayToken`, `serveStaticFile`, `mimeTypeFor`. Its only inward
dependencies are named functions it calls, which is exactly what makes it liftable.

**Do it incrementally.** One module per commit, `typecheck` + `build` + `npm test`
green each time. A big-bang refactor of a file nobody can read is how you lose a
weekend.

---

## 2. Nine complete surfaces are unreachable

**Status:** open, and it is a decision rather than work.

```
V1_HIDDEN_NAV      manager, marketplace, routines, gallery, graph, todo, pulse
V1_HIDDEN_SETTINGS mcp, usage
```

Each one is built, compiles, ships inside the bundle, and has no route to it.
This is the "logic shipped with no button" complaint, at scale, in the repo that
complains about it.

**Done looks like:** every entry either un-hidden or deleted. Not a third state.
Un-hiding is deleting a string from a `Set`; deleting is real removal, and the
git history keeps it if it is ever wanted back.

**Bias toward cutting.** Hidden code still has to compile, still gets carried by
every refactor, and still has to be understood by anyone reading around it.
Seven workspaces is a lot of tax for surfaces nobody can open.

---

## 3. The two features the README leads with are off by default

**Status:** open.

11 store flags default `false`, behind 8 documented features. Two of them matter
more than the rest:

- **Depths** (`depthRoutingEnabled`) — the per-turn difficulty ladder. This is
  the genuinely differentiated idea, the one no competitor ships.
- **Oracle** (`prewarmEnabled`, `oracleCloudEnabled`, `oracleSimilarityEnabled`)
  — the entire basis of the "fastest" claim on the front page.

If the best ideas are behind flags, the default experience is not the product.
Someone who installs Metis and uses it as shipped never sees the thing that makes
it Metis.

**Done looks like:** Depths on by default, or the README stops leading with it.
Either is honest. The current pairing is not.

---

## 4. The suites assert source, not behaviour

**Status:** open.

29 suites, and suite 28 alone carries 154 assertions — most of them regexes
against `App.tsx` source text. That catches *drift* (a constant renamed, a guard
removed) and does not catch *breakage*.

The evidence is that both real bugs found on 2026-08-16 were found by running the
thing in a browser, not by any suite:

- the blank page (`bddfad0`) — one wrong-shaped response unmounted the entire app
- the dead stop button (`9c9d09d`) — a control that rejected while its capability
  was live one route over

Both were invisible to 154 passing assertions.

**Done looks like:** the throwaway harness becomes a permanent suite. It already
exists in rough form and was rebuilt from scratch three times in one session:
a small node server that imports the COMPILED `gateway-app-shell.js`, serves the
real `dist/`, stubs `/v1/bridge`, and drives the DOM. Serving a deliberately
WRONG value is what found the blank page — that technique should be a test, not a
thing someone thinks to try.

---

## 5. "Metis maintains Metis" is the demo, and it is blocked on item 1

**Status:** blocked.

Nothing would prove the product like the product doing its own maintenance, with
the routing trace and `walkthrough.md` as the receipt. Every competitor
reconstructs a run report from tool calls afterwards; Metis has the depth
judgement and the serving model as typed records at the moment each turn ends.
That is the demo nobody else can film.

`shared/write-guard.ts` is step one and it is defensive — it stops the bad
outcome, it does not enable the good one. The good one needs item 1.

**Done looks like:** a Metis loop lands a real commit on this repo, unattended,
with its walkthrough in the PR.

---

## What is already fixed

Kept here so the list does not re-accumulate silently.

- ~~A wrong-shaped response blanked the whole app.~~ Fixed 2026-08-16
  (`bddfad0`): `orKeep` on the dangerous state sets, plus an error boundary,
  which the renderer had none of.
- ~~The browser client rendered a stop button that rejected.~~ Fixed 2026-08-16
  (`9c9d09d`): the three `reduce`-class members are reachable.
- ~~A generated write could truncate a large file.~~ Guarded 2026-08-16
  (`2864d8e`). Treats the symptom of item 1, not item 1.
- ~~The README claimed both that tests existed and that they did not.~~ Fixed
  2026-08-16; `12-doc-honesty` now fails a doc that denies the suites it ships.
