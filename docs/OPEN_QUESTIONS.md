# Open questions

**This is a register, not a procedure.** It exists so findings survive between
sessions, not so anyone follows it in order. Nothing here is a step to perform.
Several entries will turn out to be wrong the moment the app is actually open,
which is the point — we work through them one at a time, live, and the answer
changes what the next question even is.

Each entry is a question worth answering about the **desktop app as it exists
today**, paired with what the code already says, so time at the keyboard is spent
on what the code cannot answer rather than on what it can.

Started 2026-08-20. Every `file:line` was read, not recalled. Line numbers rot;
the surrounding names do not.

---

## The benchmark

### Are the results actually up to date?

**Code says: no, and it is not a data-freshness problem, it is a hardcoded-table
problem.**

`GPUS` (`App.tsx:1061`) is six hand-written entries: RTX 3060, 4070, 4080, 4090,
Apple M3 Max, and CPU-only. Nothing newer than a 4090, no AMD, no Intel Arc, no
laptop parts. `LOCAL_MODELS` (`App.tsx:1081`) is likewise hand-written, and
carries `tps` figures — `tps: 95`, `tps: 78` — that are estimates typed into a
table, not measurements taken from anything.

**Cannot tell from the code:** whether the *recommendations* it produces are
still good advice despite the stale inputs. A table can be out of date and still
land on the right model.

### Is it measuring anything at all?

**Code says: no.** The run is a `setInterval` ticking a progress number over four
hardcoded strings, one of which is literally `"Simulated decode/VRAM capture"`
(`App.tsx:11614`). There is no hardware probe anywhere — no `os.totalmem`, no GPU
query. The GPU is whichever entry you pick from the list of six.

**This is already known and is why the whole surface is cut from the browser
client** (`BROWSER_HIDDEN_NAV`). On the desktop it still renders.

### Can I download the results, like I asked for?

**Code says: no, and the reason is unusually clear.** `BenchmarkStep`
(`App.tsx:538`) declares six steps including `"export"`. `BENCHMARK_STEPS`
(`App.tsx:1023`) lists all six with labels, ending `{ key: "export", label:
"Export" }`.

`BENCHMARK_STEPS` is referenced **nowhere else in the file**. Neither is
`BENCHMARK_TARGETS` (`App.tsx:1031`). And the only step values ever *assigned*
are `welcome`, `running` and `review` — `target`, `profile` and `export` are
never set and never rendered.

So the six-step flow is a described flow, not a built one. Export was named and
not written.

### Does it take preferences into account?

**Code says: it has its own preference, and does not read the one you set.**

There are two, and they do not talk:

- `modelPreference` on the profile — `local | cloud | hybrid`, set during
  onboarding (`App.tsx:2431`), read by `composeBuiltinDecision`
  (`main.ts:3521`) to influence real routing.
- `benchmarkLocalFirst` — a separate store boolean the wizard reads
  (`App.tsx:11618`) to weight its recommendation.

Nothing reads the first when computing the second.

**Cannot tell from the code:** which of the two you *expect* to win, and whether
the split is a bug or two deliberately different questions.

---

## Identity and prompts

### Does the AI get my name?

**Code says: yes, and it was built for exactly this complaint.**
`main.ts:2394-2404` injects `The user's name is ${name}.` and the comment names
the reason — the model hallucinated "Alex"/"Luna" when asked its owner's name.
It is injected at the single choke point every prompt assembly funnels through,
so chat, builds and Oracle drafts all get it identically.

**Cannot tell from the code:** whether your profile actually has a name saved,
and whether a model given the line then *uses* it when asked. The injection
existing and the answer being right are different facts.

---

## Running commands

### Can it run commands on my computer?

**Code says: yes, through `runCommandOperation` (`main.ts:4708`), using
`execFileAsync` with `windowsHide`, a 1 MB output buffer, and a `timeout` of
8,000 ms.**

**The 8-second timeout is worth pointing at.** This repo's own `npm test` takes
longer than that. So a command that would prove the work was done can time out
and be recorded as a failure on a machine where it would have passed — which
matters because loop evidence is built from these operations, and an operation
"counts only if it CHECKED something".

**Cannot tell from the code:** how often that actually bites in practice versus
in theory.

---

## The tutorial

### Is the tutorial working?

**Code says: there is no tutorial.** No `tutorial`, `guidedTour`, `coachmark` or
equivalent exists anywhere in `App.tsx` or `main.ts`.

The two things that might be meant instead:

- `FirstRunOnboarding` (`App.tsx:2328`), gated on `window.metisProfile` and on
  `onboardedAt` being unset — so it shows once, on a fresh profile.
- The benchmark wizard, which is the first-run gate.

**Needs you to say which one you meant** before it is worth investigating
further.

---

## The ladder (Depths)

### Is the rung ladder doing what we designed?

**Code says it is wired and off by default.** `depthRoutingEnabled` gates it in
two places (`main.ts:6398`, `main.ts:10082`), and with the flag off
`classifyRouteDepth` never runs at all.

**This is the biggest thing on the list and the least answerable from source.**
Whether the *judgement* is right — whether a turn called trivial really was
trivial, whether the rung it picked was the one you would have picked — cannot be
read out of the code. It needs real prompts, with the flag on, and someone who
knows what the right answer was.

**Related, already recorded:** the rung ledger renders in Settings > Usage, which
sits in `V1_HIDDEN_SETTINGS` — so the evidence for judging this is currently
behind a hidden section.

---

## How to use this file

Add questions as they come up. Record the answer next to the question when one
arrives, and strike the question rather than deleting it, the same way
[`LIMITATIONS.md`](LIMITATIONS.md) does — a question that turned out to be
answered is worth as much as an open one, because it stops it being asked again.

Findings above are from reading the code and may be wrong about intent even where
they are right about what is written.
