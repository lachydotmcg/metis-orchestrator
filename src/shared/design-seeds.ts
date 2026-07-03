import type { DesignSeed } from "./runtime-contracts.js";

/**
 * Hand-curated design seed bank (docs/FABLE_PLANS.md section 1).
 *
 * Small local models mode-collapse to the statistical average of web design:
 * purple/violet gradients, Inter, hero-features-footer, "What would you like
 * to build?". They can't reliably *choose* a distinctive aesthetic, but they
 * are excellent at *executing* one when it's handed to them as a concrete,
 * specific constraint bundle. This bank is that bundle.
 *
 * Curated once, by hand, deliberately spread across genuinely distinct
 * aesthetics with real Google-Fonts-available type pairings and coherent
 * 4-5 hex palettes. No seed here is built around a purple/violet gradient.
 */
export const designSeeds: DesignSeed[] = [
  {
    id: "brutalist-paper",
    name: "Brutalist paper",
    palette: ["#f4f1ea", "#141414", "#c8442c", "#8a8577"],
    type: { display: "Space Grotesk", body: "Newsreader" },
    layout: "oversized numerals, hard 1px rules, asymmetric 12-col grid, generous whitespace",
    motion: "instant transitions, no easing, hover = invert",
    voice: "dry, confident, short sentences"
  },
  {
    id: "editorial-serif",
    name: "Editorial serif",
    palette: ["#fbfaf7", "#1c1a17", "#a4392b", "#c9a86a", "#5c5750"],
    type: { display: "Fraunces", body: "Source Serif 4" },
    layout: "magazine masthead, drop caps, pull quotes, 2-3 column text with a wide margin rail",
    motion: "slow cross-fades on scroll, underline draws in on link hover",
    voice: "literary, measured, first-person editorial asides"
  },
  {
    id: "swiss-international",
    name: "Swiss international",
    palette: ["#ffffff", "#e30613", "#111111", "#c7c7c7"],
    type: { display: "Helvetica Now", body: "Inter Tight" },
    layout: "strict baseline grid, flush-left ragged-right type, generous negative space, one accent red rule per section",
    motion: "no motion beyond opacity fades, everything snaps to the grid",
    voice: "objective, factual, no adjectives that aren't load-bearing"
  },
  {
    id: "terminal-mono",
    name: "Terminal mono",
    palette: ["#0a0e0a", "#39ff88", "#00d4ff", "#f5f5f0"],
    type: { display: "JetBrains Mono", body: "IBM Plex Mono" },
    layout: "single-column console feed, ASCII dividers, blinking cursor caret, left-aligned prompt markers ($ >)",
    motion: "typewriter reveal on headlines, cursor blink, scanline flicker on hover",
    voice: "terse, technical, imperative mood like CLI output"
  },
  {
    id: "warm-organic",
    name: "Warm organic",
    palette: ["#fbf6ee", "#3c3226", "#c97b4a", "#7f9b6e", "#e8c98a"],
    type: { display: "Fraunces", body: "Karla" },
    layout: "soft rounded cards, hand-drawn dividers, off-grid overlapping blobs, generous rounded corners",
    motion: "gentle spring easing, elements settle with slight overshoot",
    voice: "warm, conversational, invites rather than instructs"
  },
  {
    id: "art-deco",
    name: "Art deco revival",
    palette: ["#0e1a1f", "#c9a24b", "#f2ead6", "#7a4a2b"],
    type: { display: "Poiret One", body: "Cormorant" },
    layout: "symmetrical fan motifs, gold hairline borders, centered stepped headers, ornamental corner flourishes",
    motion: "elegant fade-up with a slight gold shimmer sweep on load",
    voice: "grandiose, ceremonial, short declarative statements"
  },
  {
    id: "neo-memphis",
    name: "Neo-Memphis",
    palette: ["#fff6e9", "#111111", "#ff5a36", "#2ec4b6", "#ffd23f"],
    type: { display: "Archivo Black", body: "Work Sans" },
    layout: "scattered geometric shapes (squiggles, dots, triangles) as decoration, tilted cards, playful collage grid",
    motion: "bouncy pop-in on scroll, shapes drift slowly like confetti",
    voice: "playful, exclamatory but not corporate-cheerful"
  },
  {
    id: "blueprint-technical",
    name: "Blueprint technical",
    palette: ["#0b2545", "#ffffff", "#8fb8de", "#f2a640"],
    type: { display: "IBM Plex Mono", body: "IBM Plex Sans" },
    layout: "graph-paper grid background, dimension lines with arrowheads, numbered annotation callouts, thin cyan rules",
    motion: "draw-on line animations (stroke-dasharray reveal), no bounce",
    voice: "precise, spec-sheet register, uses measurements and labels"
  },
  {
    id: "riso-print",
    name: "Riso print",
    palette: ["#f4efe4", "#ff5470", "#00a1b7", "#2b2b2b"],
    type: { display: "Space Grotesk", body: "Archivo" },
    layout: "misregistered overlapping color layers, visible halftone texture, torn-edge dividers, dense collage sections",
    motion: "gritty crossfade, slight jitter on hover like print misregistration",
    voice: "zine-like, punchy fragments, occasional all-caps emphasis"
  },
  {
    id: "dark-luxury",
    name: "Dark luxury",
    palette: ["#0c0c0d", "#d4af6a", "#f5f2ec", "#3a3630"],
    type: { display: "Cormorant Garamond", body: "Manrope" },
    layout: "full-bleed dark sections, thin gold hairlines, centered wordmark, extreme letter-spacing on labels",
    motion: "slow 400ms fades, gold underline glides in on hover",
    voice: "restrained, understated confidence, minimal copy"
  },
  {
    id: "pastel-soft-ui",
    name: "Pastel soft-UI",
    palette: ["#fdf7fb", "#3a2e39", "#f7b6c2", "#a7d8d9", "#f9e0a2"],
    type: { display: "Quicksand", body: "Nunito" },
    layout: "soft neumorphic cards with dual-tone shadows, pill buttons, rounded-everything, breathable padding",
    motion: "soft scale-up on press, shadows deepen smoothly on hover",
    voice: "friendly, encouraging, plain language over jargon"
  },
  {
    id: "newspaper-broadsheet",
    name: "Newspaper broadsheet",
    palette: ["#f7f4ec", "#1a1a1a", "#8b1e1e", "#7d7460"],
    type: { display: "Playfair Display", body: "PT Serif" },
    layout: "dense multi-column text, hairline column rules, masthead banner, byline/dateline conventions",
    motion: "no motion, static as ink on paper — only link color shift on hover",
    voice: "reportage tone, headline + deck + byline structure"
  },
  {
    id: "japanese-minimal",
    name: "Japanese minimal",
    palette: ["#fbfbf9", "#1f1f1f", "#b23a2e", "#c9c4b8"],
    type: { display: "Zen Kaku Gothic New", body: "Noto Serif JP" },
    layout: "extreme negative space, single vertical accent stroke, off-center focal point, thin rule dividers",
    motion: "near-imperceptible fades, 600ms+ duration, nothing rushes",
    voice: "spare, few words, each one considered"
  },
  {
    id: "retro-os",
    name: "Retro OS",
    palette: ["#c0c0c0", "#000080", "#ffffff", "#008080", "#000000"],
    type: { display: "VT323", body: "Chicago" },
    layout: "beveled window chrome, title bars with close/min buttons, pixel icons, draggable-looking panels",
    motion: "instant snaps like a 90s OS, no easing, click = pixel-perfect state change",
    voice: "nostalgic, literal labels like a desktop app (File, Edit, Help)"
  },
  {
    id: "vaporwave-restrained",
    name: "Vaporwave, restrained",
    palette: ["#f2ede4", "#2b1f3d", "#ff8a9b", "#5ec8d8"],
    type: { display: "Poppins", body: "Rubik" },
    layout: "low-saturation gradient horizon bands used sparingly, grid-line perspective floor as a single hero motif only",
    motion: "slow parallax drift on the horizon element, otherwise static",
    voice: "wistful, a little ironic, short evocative phrases"
  },
  {
    id: "industrial",
    name: "Industrial",
    palette: ["#1b1b1b", "#e8e4da", "#d97635", "#5a5a52"],
    type: { display: "Oswald", body: "Barlow" },
    layout: "riveted panel textures, warning-stripe accents used sparingly, condensed uppercase headers, stark grid",
    motion: "hard mechanical snaps, hover = brief stripe flash",
    voice: "utilitarian, stenciled, safety-label directness"
  },
  {
    id: "botanical",
    name: "Botanical field guide",
    palette: ["#f6f3ea", "#2f3b2a", "#7c9473", "#c9a06a", "#3e2d22"],
    type: { display: "Cormorant", body: "Lora" },
    layout: "pressed-leaf illustration motifs in margins, index-card style content blocks, thin ruled lines like a naturalist's notebook",
    motion: "leaves/lines fade in with a gentle 2-3deg rotation settle",
    voice: "observational, precise naming, field-notes register"
  },
  {
    id: "museum-placard",
    name: "Museum placard",
    palette: ["#faf9f6", "#101010", "#9c8c6e", "#d6d0c4"],
    type: { display: "Libre Caslon Text", body: "Source Sans 3" },
    layout: "wall-label proportions, small caps eyebrow labels, generous margin around a single centered focal object",
    motion: "no motion except a slow spotlight-style opacity fade-in",
    voice: "curatorial, authoritative but brief, factual captions"
  },
  {
    id: "zine-punk",
    name: "Zine punk",
    palette: ["#101010", "#f2f2f2", "#ff2d2d", "#f2e94e"],
    type: { display: "Anton", body: "Courier Prime" },
    layout: "cut-and-paste collage, mismatched rotated headlines, photocopy borders, gaffer-tape corner accents",
    motion: "abrupt jump-cuts, no easing, occasional glitch shake on hover",
    voice: "loud, urgent, fragment sentences, DIY manifesto energy"
  },
  {
    id: "corporate-1970s",
    name: "Corporate 1970s",
    palette: ["#f3ead2", "#6b3f1d", "#c96f34", "#2f4d3a", "#e2b13c"],
    type: { display: "Cooper Hewitt", body: "Georgia" },
    layout: "chevron dividers, circular logo mark motif, warm earth-tone bands stacked horizontally",
    motion: "gentle horizontal slide-ins on scroll, no bounce",
    voice: "optimistic corporate-modernist, plainspoken mission statements"
  },
  {
    id: "scandinavian-clean",
    name: "Scandinavian clean",
    palette: ["#ffffff", "#22262a", "#d1443a", "#e8e6e1"],
    type: { display: "Sora", body: "Inter" },
    layout: "airy grid, thin 1px borders, functional furniture-catalog composition, lots of breathing room between blocks",
    motion: "subtle 150ms opacity fades only, nothing decorative",
    voice: "plain, functional, no hyperbole"
  },
  {
    id: "gothic-manuscript",
    name: "Gothic manuscript",
    palette: ["#120f0d", "#e8dcc0", "#8a1f1f", "#5c4a2e"],
    type: { display: "UnifrakturCook", body: "EB Garamond" },
    layout: "illuminated-manuscript initial caps, vertical dividers like columns on a page, dense framed borders",
    motion: "slow candlelit flicker on accent elements, otherwise static",
    voice: "archaic-flavored but readable, ceremonial phrasing"
  },
  {
    id: "candy-pop",
    name: "Candy pop",
    palette: ["#fff9f5", "#241a1a", "#ff6f61", "#ffd166", "#4ecdc4"],
    type: { display: "Baloo 2", body: "Nunito Sans" },
    layout: "chunky rounded blobs as section backgrounds, sticker-style badges, oversized friendly buttons",
    motion: "squash-and-stretch pop on click, playful wobble on hover",
    voice: "upbeat, short punchy phrases, occasional em-dash energy (only in copy, not layout)"
  },
  {
    id: "constructivist",
    name: "Russian constructivist",
    palette: ["#e8e2d5", "#1a1a1a", "#c1272d", "#2b2b2b"],
    type: { display: "Rajdhani", body: "PT Sans" },
    layout: "diagonal red banners, bold geometric arrows, overlapping angular blocks, propaganda-poster hierarchy",
    motion: "sharp diagonal wipes, no easing curves — linear only",
    voice: "urgent, rallying, short imperative slogans"
  },
  {
    id: "desert-modern",
    name: "Desert modern",
    palette: ["#f1e4d3", "#4a3728", "#c1673a", "#8f9779"],
    type: { display: "Marcellus", body: "Jost" },
    layout: "wide horizontal bands like mesa strata, generous top/bottom padding, centered minimal nav",
    motion: "slow heat-shimmer style fade, elements rise gently on scroll",
    voice: "unhurried, spacious sentences, sensory descriptions"
  },
  {
    id: "lab-notebook",
    name: "Lab notebook",
    palette: ["#fbfbf6", "#141a1f", "#2f7d6b", "#c94f4f"],
    type: { display: "IBM Plex Sans", body: "IBM Plex Serif" },
    layout: "graph-ruled background, handwritten-style annotation callouts, numbered figure captions, data-table heavy",
    motion: "instant reveals, red annotation marks 'stamp' in with a quick scale-pop",
    voice: "empirical, hedged claims, cites specifics and numbers"
  },
  {
    id: "coastal-linen",
    name: "Coastal linen",
    palette: ["#f7f4ee", "#2c3e3a", "#5f8a8b", "#d9a774"],
    type: { display: "Fraunces", body: "Work Sans" },
    layout: "generous linen-textured whitespace, horizontal wave-line dividers, soft-edged photography frames",
    motion: "slow tide-like fade/slide up, 500ms ease-out",
    voice: "unhurried, breezy, sensory but not flowery"
  },
  {
    id: "pixel-arcade",
    name: "Pixel arcade",
    palette: ["#0d0221", "#ff2079", "#00e5ff", "#f9f871", "#1a1a2e"],
    type: { display: "Press Start 2P", body: "Space Mono" },
    layout: "pixel-border panels, chunky 4px grid alignment, scoreboard-style stat blocks",
    motion: "hard 8-step frame transitions, no smoothing, hover = color cycle flicker",
    voice: "high-energy, arcade-cabinet callouts, short bursts"
  },
  {
    id: "monastic-quiet",
    name: "Monastic quiet",
    palette: ["#f5f2ec", "#26241f", "#6b6355", "#a9744f"],
    type: { display: "Crimson Pro", body: "Crimson Pro" },
    layout: "single narrow reading column, wide margins, minimal chrome, no decorative elements at all",
    motion: "none — instant, static, contemplative",
    voice: "quiet, unhurried, one idea per sentence"
  },
  {
    id: "chalkboard-classroom",
    name: "Chalkboard classroom",
    palette: ["#1e2b23", "#f5f1e6", "#e8c14d", "#7fae8e"],
    type: { display: "Kalam", body: "Architects Daughter" },
    layout: "chalk-dust texture panels, hand-drawn underlines, sticky-note style callout boxes",
    motion: "chalk 'write-on' stroke reveal for headlines, otherwise static",
    voice: "encouraging teacher tone, clear step-by-step framing"
  },
  {
    id: "cyber-noir",
    name: "Cyber noir",
    palette: ["#08090a", "#e6e6e6", "#e0263f", "#4a4e69"],
    type: { display: "Chakra Petch", body: "Rajdhani" },
    layout: "angular clipped-corner panels, thin scanline overlay, HUD-style corner brackets on cards",
    motion: "quick 120ms snaps with a red flash-glitch on hover",
    voice: "clipped, surveillance-report tone, short fragments"
  },
  {
    id: "quilted-craft",
    name: "Quilted craft",
    palette: ["#faf3e7", "#3d2b1f", "#c25b4a", "#7a9e7e", "#e0b354"],
    type: { display: "DM Serif Display", body: "DM Sans" },
    layout: "patchwork grid of varied-size blocks like quilt squares, stitched-line dashed borders",
    motion: "gentle patchwork-piece slide-and-settle on scroll",
    voice: "homey, personal, storytelling asides"
  },
  {
    id: "signal-orange-safety",
    name: "Signal orange safety",
    palette: ["#161616", "#f5f5f2", "#ff5e00", "#3a3a3a"],
    type: { display: "Barlow Condensed", body: "Barlow" },
    layout: "diagonal hazard-stripe accents used only as thin borders, dense uppercase labeling, tight condensed grid",
    motion: "hard linear transitions, hover = orange fill wipe",
    voice: "alert, direct, safety-manual clarity"
  },
  {
    id: "porcelain-ceramic",
    name: "Porcelain ceramic",
    palette: ["#fbfaf8", "#2e2a26", "#b7a99a", "#7d8f7a"],
    type: { display: "Antic Didone", body: "Karla" },
    layout: "crackle-glaze texture subtly in backgrounds, centered symmetrical compositions, thin rule frames",
    motion: "very slow 700ms fades, nothing sudden — glass-fragile pacing",
    voice: "refined, understated, few but precise words"
  },
  {
    id: "trail-topographic",
    name: "Trail topographic",
    palette: ["#f4f0e6", "#2a2f26", "#8b5e3c", "#4c6b4f", "#c1a15a"],
    type: { display: "Bitter", body: "Public Sans" },
    layout: "contour-line background texture, waypoint-marker bullet icons, elevation-profile style dividers",
    motion: "slow pan-drift on background contours, content fades up on scroll",
    voice: "practical, guide-book directness, distance/time specifics"
  },
  {
    id: "citrus-market",
    name: "Citrus market",
    palette: ["#fff8ec", "#2b2118", "#e8622c", "#3f7a4e", "#f2b134"],
    type: { display: "Fraunces", body: "Mulish" },
    layout: "hand-lettered price-tag style callouts, crate-label borders, stacked produce-market grid",
    motion: "fresh bouncy pop-in, quick 200ms with slight overshoot",
    voice: "bright, inviting, market-stall enthusiasm without being cheesy"
  },
  {
    id: "carbon-fiber-tech",
    name: "Carbon fiber tech",
    palette: ["#0e0f11", "#eceff1", "#00c2a8", "#3d4148"],
    type: { display: "Eurostile", body: "Titillium Web" },
    layout: "diagonal carbon-weave texture accents, sharp bevel-edge cards, telemetry-style data readouts",
    motion: "fast 100ms linear snaps, teal accent underline sweeps on hover",
    voice: "performance-spec tone, confident and technical"
  },
  {
    id: "hand-bound-book",
    name: "Hand-bound book",
    palette: ["#f2ead9", "#33281e", "#8c3b2e", "#5e6e4f"],
    type: { display: "Spectral", body: "Spectral" },
    layout: "thread-stitch spine motif down one edge, chapter-heading numerals, generous leading like a printed page",
    motion: "page-turn style cross-fade between sections, slow and deliberate",
    voice: "storyteller's voice, complete sentences, gentle pacing"
  },
  {
    id: "glacier-clinical",
    name: "Glacier clinical",
    palette: ["#f7fafc", "#0f1f2b", "#2f7fb0", "#c9d6dc"],
    type: { display: "Söhne", body: "Public Sans" },
    layout: "cool clinical whitespace, thin blue data-line accents, precise alignment to an 8px grid",
    motion: "crisp 150ms ease-out, no overshoot, everything feels calibrated",
    voice: "clear, reassuring, evidence-forward phrasing"
  }
];

export function loadDesignSeedBank(): DesignSeed[] {
  return designSeeds;
}
