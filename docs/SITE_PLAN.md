# Metis Landing Page Plan

Written 2026-07-21 from Lachy's brief: animations essentially everywhere
(reference: nosdesk.com), the hero shows off ROUTING with kinetic text
(faster | cheaper | smarter), a GPT Image 2 still animated via Kling as a
cinematic beat, then depth on every feature. Status: PLAN, nothing built.

## What nosdesk actually does, and what we steal

- The HERO IS THE PRODUCT: a live-looking helpdesk mock, not a screenshot.
  We steal this hard — Metis's hero is a live routing animation, because
  routing is the product.
- Kinetic marquee tickers list every real feature per section, looping.
  Steal: one ticker per surface (Loops, Depths, Oracle, Orchestration).
- A four-cell trust strip under the hero (source/hosting/setup/data).
  Steal with our own truths: LOCAL-FIRST · BYO KEYS · FSL SOURCE · YOUR
  DATA STAYS HOME.
- Everything listed is real and shipped, and the page says so. We keep that
  discipline: the site only claims what the README's VERIFIED/SHIPPED
  markers back.

## The hero (code-driven, not video)

A full-viewport dark canvas in the app's own palette (charcoal #1b1b1b,
slate accent, the grid). Center: a stylised orchestration graph — router
node at the heart, provider tiles in orbit (abstract glyphs, legally clean).
A PROMPT PACKET drops in from the composer at the bottom, the router pulses,
and the packet streaks along a wire to a different tile each loop. As each
packet lands, the headline's rotating word flips in sync:

    Route every prompt  [faster]     -> packet lands on the local tile
    Route every prompt  [cheaper]    -> packet lands on DeepSeek-ish tile
    Route every prompt  [smarter]    -> packet lands on the frontier tile
    Route every prompt  [privately]  -> packet loops back to the local tile

The word flip and the packet landing are the SAME timeline, so the copy is
literally demonstrated by the animation. Sub-head: "Metis is a local-first
router that sends each prompt to the model that deserves it." Two CTAs:
Download for Windows · Read the source.

Why code (GSAP/SVG) and not a Kling video for the hero: it loops perfectly,
stays crisp on any screen, weighs ~nothing, and can react to scroll and
pointer. The AI-generated cinematic gets its own moment below instead.

## Section flow

1. HERO — routing animation + kinetic word flip (above).
2. TRUST STRIP — four cells: Local-first · Bring your own keys · Source
   available (FSL) · Your data stays home. Small, quiet, immediate.
3. THE ROUTER, IN DEPTH — split layout: left, a mock composer that "types"
   prompts on loop ("fix this typo" / "audit this architecture"); right,
   the depth stack L1/L2/L3 lighting up the rung each prompt lands on, with
   honest cost captions ("two words should not cost cloud money").
   Scroll-triggered.
4. CINEMATIC BEAT — the GPT Image 2 -> Kling asset, full-bleed: the tile
   swap scene (a provider tile glides in over the grid and replaces
   another). Overlay line: "With Metis, it's that easy." This is the one
   baked-video moment on the page, and it earns its bytes.
5. FEATURE DEEP-DIVES — one section per surface, each with a nosdesk-style
   looping ticker of its REAL features plus one animated vignette:
   - Orchestration: node canvas mock, a node dragging in.
   - Loops: a goal card ticking through turns, helpers spawning, the
     budget meter filling, "stops itself" as the punchline.
   - Oracle: a prompt being typed while the answer streams BEFORE enter is
     pressed; the measured 4.1–9.5x TTFT stat, stated as measured.
   - Depths: the L1/L2/L3 stack again, interactive on hover.
   - Flowchart Loops: a text chain "read -> plan -> research & review ->
     implement" drawing itself, the & pair running side by side.
6. THE HONESTY SECTION — short: markers (VERIFIED/SHIPPED/FLAG OFF), link
   to LIMITATIONS.md. Nobody else does this; it is a differentiator.
7. GET IT — download (installer), CLI one-liner, BYO keys note, FSL badge.
8. FOOTER — GitHub, Discord, docs.

## Asset pipeline (the Kling beat)

1. Stills via GPT Image 2 (the imageRoute chain in the app can do this once
   a billed key exists): the two composition-locked frames from the earlier
   session — tile A on the grid baseplate, tile B settled in its place.
   Abstract glyphs, not third-party trademarks.
2. Kling (first/last frame mode, 3.0 if the picker has it with that mode,
   else 2.x) interpolates the swap with the motion prompt already drafted.
3. Post: typography overlay ("With Metis, it's that easy.") in the edit,
   never generated. Export 1080p H.264 + a poster frame; lazy-load, play
   muted on scroll-enter, respect prefers-reduced-motion.

## Stack

- Vite + vanilla TypeScript (no framework — the page is one route and the
  animations are timeline work, not state work).
- GSAP + ScrollTrigger for every scroll-bound sequence; Lenis for smooth
  scroll; SVG for the hero graph (the app's own node grammar).
- prefers-reduced-motion: every looping animation gets a static fallback.
- Static deploy on Netlify (Lachy's usual), separate repo `metis-site` so
  site deploys never queue behind app CI.

## Open decisions for Lachy

- Domain (metis.dev-ish? getmetis? decide before OG tags).
- Whether pricing appears at all in v1 or the page stays "free, BYO keys"
  until the subscription story is real.
- Which real screen recordings (if any) accompany the mocks — the honesty
  culture says at least one real capture beats ten mocks.
