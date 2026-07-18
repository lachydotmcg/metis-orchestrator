/**
 *  Metis interface sound (docs/DRILL_PLAN.md B12.10).
 *
 *  TWO TIERS, ONE INSTRUMENT. The informational tier says something happened
 *  that you could not otherwise see (a run finished, a delete armed). The
 *  decorative tier - clicks and hover - only confirms your own hand landed on
 *  something, so it is quieter, cheaper and the first thing dropped when the
 *  throttle runs short. Both tiers are the same struck body at the same tuning.
 *
 *  ONE INSTRUMENT, struck differently. Every cue is the same struck body -
 *  inharmonic partials at 1.00 / 2.76 / 5.40 x the fundamental at 0 / -12 /
 *  -20 dB with an exponential decay, plus a 6ms bandpassed white-noise
 *  contact transient. Cues differ ONLY by pitch, weight and grain spacing,
 *  never by timbre, so the app reads as one object rather than a soundboard.
 *
 *  Everything here is off by default and stays silent on any failure: a
 *  missing AudioContext, a blocked autoplay policy or a thrown node call must
 *  never surface to a caller or delay the interaction that triggered it.
 */

/** Tier 1: something happened. Fired from explicit `sound.play` call sites. */
export type InformationalCue = "send" | "runComplete" | "runError" | "destructiveArm" | "destructiveCommit";

/** Tier 2: your hand landed on something. Fired only by the delegated
 *  listeners in soundRouter.ts, never by a hand-written call site. */
export type DecorativeCue =
  | "click"
  | "clickPrimary"
  | "toggleOn"
  | "toggleOff"
  | "navSwitch"
  | "popoverOpen"
  | "popoverClose"
  | "hover";

export type SoundCue = InformationalCue | DecorativeCue;

export type SoundSettings = {
  enabled: boolean;
  volume: number;
  /** The decorative tier (clicks and hover). Nested under `enabled`: this being
   *  true means nothing while the master switch is off. */
  decorative: boolean;
};

const DECORATIVE_CUES: ReadonlySet<SoundCue> = new Set<SoundCue>([
  "click",
  "clickPrimary",
  "toggleOn",
  "toggleOff",
  "navSwitch",
  "popoverOpen",
  "popoverClose",
  "hover"
]);

export type SoundPlayOptions = {
  /** `runComplete` only: how long the run actually took. A sound for
   *  something that felt instant is noise, so short runs are dropped. */
  runDurationMs?: number;
};

/** Sound is opt-in: `enabled` false means the whole feature is silent. Once the
 *  user has opted in, `decorative` true is the owner's chosen default for what
 *  the feature then sounds like - it is a shape preference inside an off-by-
 *  default feature, not a second thing switched on behind their back. */
export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: false, volume: 0.5, decorative: true };

/** The Settings > Appearance > Sound preview reads this. Informational only:
 *  the decorative tier is described by its own hint line, not enumerated, since
 *  "everything you click" is not a list worth printing. */
export const SOUND_CUES: { id: InformationalCue; label: string; hint: string }[] = [
  { id: "send", label: "Send", hint: "You submit a prompt" },
  { id: "runComplete", label: "Run complete", hint: "The same figure slowed - a run answers its own question" },
  { id: "runError", label: "Run failed", hint: "Two neighbouring tones left to rub against each other" },
  { id: "destructiveArm", label: "Delete armed", hint: "Deliberately dead: no partials, nothing above 900Hz" },
  { id: "destructiveCommit", label: "Delete committed", hint: "Low, short and final" }
];

// ---- Fixed tuning: D minor pentatonic. Nothing here is computed from a
// scale degree at runtime; the whole app only ever speaks these notes. ----
const D3 = 146.83;
const D4 = 293.66;
const F4 = 349.23;
const G4 = 392.0;
const A4 = 440.0;
const C5 = 523.25;
const D5 = 587.33;

// ---- The instrument ----
const PARTIAL_RATIOS = [1, 2.76, 5.4];
const PARTIAL_GAINS = [1, 0.2512, 0.1]; // 0 / -12 / -20 dB
const ATTACK_S = 0.003;
/** exponentialRampToValueAtTime can never reach 0, so the envelope ramps to a
 *  floor and then LINEARLY to true zero. Stopping on a non-zero sample is the
 *  classic click artefact. */
const RELEASE_FLOOR = 0.0006;
const RELEASE_TAIL_S = 0.02;
const NOISE_S = 0.006;
const NOISE_HZ = 4200;
const NOISE_Q = 1.8;
const NOISE_GAIN = 0.5;
/** Leaves the limiter room to work at volume 1.0. */
const OUTPUT_HEADROOM = 0.5;
/** setTargetAtTime time-constant for master volume changes; short enough that
 *  the slider feels immediate, long enough that it never steps audibly. */
const VOLUME_GLIDE_S = 0.01;

// ---- Throttling ----
/** A LEAKY bucket, not a periodic reset: tokens accrue continuously with
 *  elapsed time, so a burst can never arrive the instant a window rolls over. */
const BUCKET_CAPACITY = 5;
const BUCKET_REFILL_PER_S = 4;
/** Tier floors, in tokens. A cue only sounds while the bucket is at or above
 *  its tier's floor, so the tiers starve in order: hover goes quiet first, then
 *  clicks, and the informational cues keep a reserve they cannot be robbed of
 *  by a user drumming on the interface. Without this the decorative tier - by
 *  far the most frequent - would drain the same bucket the "your run failed"
 *  cue needs (docs/DRILL_PLAN.md B12.10). */
const TIER_FLOOR_INFORMATIONAL = 1;
const TIER_FLOOR_CLICK = 2;
const TIER_FLOOR_HOVER = 3;
/** Second, independent hover gate: a hard minimum spacing between hover cues.
 *
 *  WHY A FAST SWEEP CANNOT BURST. Dragging the pointer down a 30-row list fires
 *  pointerover ~30 times in maybe 300ms. The interval gate alone caps that at
 *  one per 90ms, which is still 3-4 in that sweep; the bucket is what stops it
 *  becoming sustained. Worked through, from a full bucket, with hover needing 3
 *  tokens to sound and spending 1:
 *    t=0ms   tokens 5.00 -> play -> 4.00
 *    t=90ms  tokens 4.36 -> play -> 3.36
 *    t=180ms tokens 3.72 -> play -> 2.72
 *    t=270ms tokens 3.08 -> play -> 2.08
 *    t=360ms tokens 2.44 -> BELOW FLOOR, dropped (and nothing is spent)
 *    t=450ms tokens 2.80 -> dropped
 *    t=540ms tokens 3.16 -> play -> 2.16
 *  So the worst case is four ticks in the first ~300ms and then a hard ceiling
 *  of roughly one per 300ms for as long as the sweep continues, no matter how
 *  fast the mouse moves. Measured against this engine: 30 hover events fired in
 *  336ms produced 4 sounds (at 0, 91, 191 and 282ms), and ~100 further events
 *  over the next second produced 3. Crossing a few rows ticks; running down a
 *  list cannot machine-gun at the pointer's event rate. */
const HOVER_MIN_INTERVAL_MS = 90;
const DUCK_RAMP_S = 0.008;
/** Same-cue retrigger ducks the still-ringing copy under the new strike
 *  rather than letting two copies sum into a loud smear. */
const DUCK_FLOOR = 0.2;
const SHORT_RUN_SUPPRESS_MS = 1500;

type CueSpec = {
  /** Grain offsets in ms plus the pitch struck at each one. */
  grains: { atMs: number; frequency: number }[];
  gain: number;
  decayS: number;
  /** false strips the upper partials, leaving the bare fundamental. */
  partials: boolean;
  /** Strips the body entirely, leaving ONLY the contact transient - the striker
   *  without the thing being struck. Hover uses this: a hover is not an action,
   *  and giving it a pitch makes a mouse sweep sound like typing. */
  contactOnly?: boolean;
  lowpassHz?: number;
  /** A second voice struck alongside every grain, offset in semitones. */
  neighbourSemitones?: number;
};

/** The shared noise buffer is ONE recording, so a neighbour voice struck at the
 *  same instant replays the identical samples and sums coherently: the contact
 *  transient lands twice as loud as every other cue's, which reads as a click
 *  rather than a strike (docs/DRILL_PLAN.md B12.10). The body doubles, the
 *  striker does not. */
type StrikeOptions = { contact: boolean };

const CUES: Record<SoundCue, CueSpec> = {
  // Ascending through the tuning: the gesture leaves and does not come back.
  send: {
    grains: [
      { atMs: 0, frequency: D4 },
      { atMs: 38, frequency: F4 },
      { atMs: 76, frequency: A4 }
    ],
    gain: 0.16,
    decayS: 0.5,
    partials: true
  },
  // THE SAME figure, slowed. Only the grain spacing changes, so a finished run
  // is audibly the answer to the send that started it.
  runComplete: {
    grains: [
      { atMs: 0, frequency: D4 },
      { atMs: 90, frequency: F4 },
      { atMs: 180, frequency: A4 }
    ],
    gain: 0.16,
    decayS: 0.5,
    partials: true
  },
  // NOTE (B12.10): the brief specifies a neighbour 1.5 semitones flat "so they
  // beat at roughly 4Hz". Those two things do not both hold - 1.5 semitones
  // below F4 is 320.25Hz, which reads as roughness (a ~29Hz difference), not a
  // 4Hz amplitude beat. The explicit interval wins here because it is the
  // stated number; a true 4Hz beat is one constant away (-0.2 semitones).
  runError: {
    grains: [{ atMs: 0, frequency: F4 }],
    gain: 0.2,
    decayS: 0.9,
    partials: true,
    neighbourSemitones: -1.5
  },
  // Deliberately dead: no partials and nothing above 900Hz, so arming a delete
  // sounds like the instrument being held rather than struck.
  destructiveArm: {
    grains: [{ atMs: 0, frequency: D4 }],
    gain: 0.16,
    decayS: 0.25,
    partials: false,
    lowpassHz: 900
  },
  destructiveCommit: {
    grains: [{ atMs: 0, frequency: D3 }],
    gain: 0.28,
    decayS: 0.45,
    partials: true
  },

  // ---- Decorative tier ----
  // Same body, same tuning, roughly a third of the informational tier's weight
  // and a fifth of its decay. These fire on EVERY click, so anything that rings
  // long enough to overlap the next one is wrong by construction.

  /** The default for anything clickable with no better answer. */
  click: {
    grains: [{ atMs: 0, frequency: G4 }],
    gain: 0.05,
    decayS: 0.09,
    partials: true
  },
  // Deliberately D4: the same pitch the `send` figure opens on. On the send
  // button this lands ~5ms before that figure starts, so it reads as the strike
  // that begins the send rather than as a second, competing sound.
  clickPrimary: {
    grains: [{ atMs: 0, frequency: D4 }],
    gain: 0.075,
    decayS: 0.16,
    partials: true
  },
  // A rising / falling pair. Nothing else in the app moves between two pitches
  // this close together, so "on" and "off" are distinguishable without being
  // learned.
  toggleOn: {
    grains: [
      { atMs: 0, frequency: A4 },
      { atMs: 55, frequency: C5 }
    ],
    gain: 0.055,
    decayS: 0.12,
    partials: true
  },
  toggleOff: {
    grains: [
      { atMs: 0, frequency: C5 },
      { atMs: 55, frequency: A4 }
    ],
    gain: 0.055,
    decayS: 0.12,
    partials: true
  },
  /** Highest and driest in the tier: moving between places should feel like a
   *  lighter act than committing to something. */
  navSwitch: {
    grains: [{ atMs: 0, frequency: D5 }],
    gain: 0.05,
    decayS: 0.1,
    partials: true
  },
  // An octave leap, tighter spaced than the toggle pair, so opening a menu is
  // audibly a bigger move than flipping a switch but a shorter one.
  popoverOpen: {
    grains: [
      { atMs: 0, frequency: D4 },
      { atMs: 34, frequency: D5 }
    ],
    gain: 0.045,
    decayS: 0.1,
    partials: true
  },
  popoverClose: {
    grains: [
      { atMs: 0, frequency: D5 },
      { atMs: 34, frequency: D4 }
    ],
    gain: 0.045,
    decayS: 0.1,
    partials: true
  },
  /** Pure contact, no note at all - see `contactOnly`. Quietest thing the app
   *  can do and still be doing something. */
  hover: {
    grains: [{ atMs: 0, frequency: G4 }],
    gain: 0.03,
    decayS: 0.01,
    partials: false,
    contactOnly: true
  }
};

type Engine = {
  ctx: AudioContext;
  master: GainNode;
  /** Built once and shared by every strike - allocating a fresh noise buffer
   *  per cue is pure garbage for an identical result. */
  noise: AudioBuffer;
};

let engine: Engine | null = null;
let settings: SoundSettings = DEFAULT_SOUND_SETTINGS;
let tokens = BUCKET_CAPACITY;
let bucketCheckedAt = 0;
let lastHoverAt = 0;
const ringing = new Map<SoundCue, GainNode[]>();
/** Monotonic count of informational cues RAISED (not necessarily heard). The
 *  click router reads it either side of a microtask to tell whether the button
 *  it is about to tick already spoke for itself - see soundRouter.ts. */
let informationalRaised = 0;
/** Anything that needs to react to the settings changing. Today that is the
 *  click router attaching and detaching its document listeners; the alternative
 *  is the router polling `isDecorativeEnabled()` on every pointer event forever,
 *  which is the cost this exists to remove (docs/DRILL_PLAN.md B12.10). */
const settingsSubscribers = new Set<() => void>();

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function applyVolume(): void {
  if (!engine) return;
  const target = clamp01(settings.volume) * OUTPUT_HEADROOM;
  // Dragging the volume slider fires this on every step, so a bare `.value =`
  // would step the master gain discontinuously THROUGH a ringing cue - the
  // zipper artefact the whole envelope design exists to avoid. A short
  // setTargetAtTime glides instead (docs/DRILL_PLAN.md B12.10).
  const { gain } = engine.master;
  const t = engine.ctx.currentTime;
  gain.cancelScheduledValues(t);
  gain.setTargetAtTime(target, t, VOLUME_GLIDE_S);
}

/** Built on the first cue that actually plays, which is always downstream of a
 *  real user gesture (submitting a prompt, clicking delete, hitting Preview) -
 *  the autoplay policy will not hand out a running context any earlier. */
function ensureEngine(): Engine | null {
  if (engine) return engine;
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  const ctx = new Ctor();
  const master = ctx.createGain();
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 20;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 14000;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  master.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(limiter);
  limiter.connect(ctx.destination);

  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_S));
  const noise = ctx.createBuffer(1, frames, ctx.sampleRate);
  const channel = noise.getChannelData(0);
  for (let i = 0; i < frames; i += 1) channel[i] = Math.random() * 2 - 1;

  engine = { ctx, master, noise };
  applyVolume();
  return engine;
}

/** Leaky token bucket. Returns false when the caller should drop the cue.
 *  `floor` is the tier's reserve: the cue only sounds while the bucket is at or
 *  above it, and a dropped cue spends nothing, so a starved tier cannot hold the
 *  bucket down for the tiers above it. */
function takeToken(now: number, floor: number): boolean {
  if (bucketCheckedAt === 0) bucketCheckedAt = now;
  tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - bucketCheckedAt) / 1000) * BUCKET_REFILL_PER_S);
  bucketCheckedAt = now;
  if (tokens < floor) return false;
  tokens -= 1;
  return true;
}

/** Duck any copy of this cue that is STILL RINGING under the new strike, so two
 *  copies never sum into a loud smear.
 *
 *  This deliberately keys off `ringing` rather than a fixed retrigger window:
 *  the previous 350ms gate was shorter than every cue's own ring time (send
 *  decays over ~576ms, runError over 900ms), so a retrigger in the gap between
 *  the two - late enough to miss the window, early enough that the last copy
 *  was still audible - summed anyway, which is the exact case the duck exists
 *  for. `ringing` holds a voice if and only if it has not ended yet, so it is
 *  already the precise answer to "is there something to duck", at any decay
 *  length, with no constant to keep in sync (docs/DRILL_PLAN.md B12.10). When
 *  nothing is ringing this is a no-op, which is what a well-spaced retrigger
 *  should be. */
function duckRinging(cue: SoundCue, active: Engine): void {
  const voices = ringing.get(cue);
  if (!voices || voices.length === 0) return;
  const t = active.ctx.currentTime;
  for (const voice of voices) {
    const level = voice.gain.value;
    voice.gain.cancelScheduledValues(t);
    voice.gain.setValueAtTime(level, t);
    voice.gain.linearRampToValueAtTime(level * DUCK_FLOOR, t + DUCK_RAMP_S);
  }
}

function releaseVoice(cue: SoundCue, voice: GainNode, nodes: AudioNode[]): void {
  const voices = ringing.get(cue);
  if (voices) {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
  }
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      /* already torn down */
    }
  }
}

/** One strike of the body at `frequency`. Every cue is made of these. */
function strike(active: Engine, cue: SoundCue, when: number, frequency: number, spec: CueSpec, opts: StrikeOptions): void {
  const { ctx } = active;
  const nodes: AudioNode[] = [];

  const voice = ctx.createGain();
  voice.gain.value = spec.gain;
  nodes.push(voice);
  if (spec.lowpassHz !== undefined) {
    const shelf = ctx.createBiquadFilter();
    shelf.type = "lowpass";
    shelf.frequency.value = spec.lowpassHz;
    voice.connect(shelf);
    shelf.connect(active.master);
    nodes.push(shelf);
  } else {
    voice.connect(active.master);
  }

  const partialCount = spec.partials ? PARTIAL_RATIOS.length : 1;
  const endsAt = when + ATTACK_S + spec.decayS + RELEASE_TAIL_S;
  let lastOsc: OscillatorNode | null = null;
  for (let i = 0; !spec.contactOnly && i < partialCount; i += 1) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency * PARTIAL_RATIOS[i];
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(PARTIAL_GAINS[i], when + ATTACK_S);
    env.gain.exponentialRampToValueAtTime(RELEASE_FLOOR, when + ATTACK_S + spec.decayS);
    env.gain.linearRampToValueAtTime(0, endsAt);
    osc.connect(env);
    env.connect(voice);
    osc.start(when);
    osc.stop(endsAt + 0.01);
    nodes.push(osc, env);
    lastOsc = osc;
  }

  // The contact transient: what the striker sounds like, not what the body
  // sounds like. Same buffer every time, filtered per strike - so exactly one
  // strike per grain gets one, no matter how many bodies that grain rings.
  let contactSource: AudioBufferSourceNode | null = null;
  if (opts.contact) {
    const contact = ctx.createBufferSource();
    contact.buffer = active.noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = NOISE_HZ;
    band.Q.value = NOISE_Q;
    const contactGain = ctx.createGain();
    contactGain.gain.setValueAtTime(NOISE_GAIN, when);
    contactGain.gain.exponentialRampToValueAtTime(RELEASE_FLOOR, when + NOISE_S);
    contactGain.gain.linearRampToValueAtTime(0, when + NOISE_S + 0.002);
    contact.connect(band);
    band.connect(contactGain);
    contactGain.connect(voice);
    contact.start(when);
    contact.stop(when + NOISE_S + 0.01);
    nodes.push(contact, band, contactGain);
    contactSource = contact;
  }

  const voices = ringing.get(cue);
  if (voices) voices.push(voice);
  else ringing.set(cue, [voice]);

  // Tear down on whichever source outlives the others: the oscillators normally,
  // but a contactOnly strike has none, and disconnecting immediately would cut
  // the 6ms transient before it had played (docs/DRILL_PLAN.md B12.10).
  const tail: AudioScheduledSourceNode | null = lastOsc ?? contactSource;
  if (tail) tail.onended = () => releaseVoice(cue, voice, nodes);
  else releaseVoice(cue, voice, nodes);
}

function playInternal(cue: SoundCue, opts: SoundPlayOptions): void {
  const decorative = DECORATIVE_CUES.has(cue);
  // Counted BEFORE every gate below, on purpose. The router's question is "does
  // this button own a sound of its own", not "was that sound audible" - a `send`
  // dropped by the throttle still means the send button is not a plain click,
  // and letting the tick through in that case would make the app loudest exactly
  // when it is already too busy (docs/DRILL_PLAN.md B12.10).
  if (!decorative) informationalRaised += 1;
  if (!settings.enabled) return;
  if (decorative && !settings.decorative) return;
  if (cue === "runComplete" && typeof opts.runDurationMs === "number" && opts.runDurationMs < SHORT_RUN_SUPPRESS_MS) {
    return;
  }

  const now = Date.now();
  // Hover's interval gate runs before anything else it could waste. See
  // HOVER_MIN_INTERVAL_MS for why this and the bucket are both needed.
  if (cue === "hover") {
    if (now - lastHoverAt < HOVER_MIN_INTERVAL_MS) return;
    lastHoverAt = now;
  }

  // Resolve the engine BEFORE spending a token: on a machine with no Web Audio
  // at all, taking the token first would drain the bucket on cues that were
  // never going to sound, and then throttle the real ones if support appeared.
  //
  // Hover reads the existing engine instead of building one. Moving a mouse is
  // not a user gesture under the autoplay policy, so a hover-built context would
  // come back suspended - a silent context created for a cue that was never
  // going to be heard. Hover sounds once something real has opened the engine.
  const active = cue === "hover" ? engine : ensureEngine();
  if (!active) return;

  // An empty bucket DROPS the cue rather than shortening it: a truncated strike
  // is a click artefact, a missing one is nothing at all.
  const floor = cue === "hover" ? TIER_FLOOR_HOVER : decorative ? TIER_FLOOR_CLICK : TIER_FLOOR_INFORMATIONAL;
  if (!takeToken(now, floor)) return;

  if (active.ctx.state === "suspended") {
    void active.ctx.resume().catch(() => {
      /* the next gesture gets another go */
    });
  }

  duckRinging(cue, active);

  const spec = CUES[cue];
  // A few ms of lead so every grain of a cue is scheduled in the future and
  // lands sample-accurate relative to its siblings.
  const base = active.ctx.currentTime + 0.005;
  for (const grain of spec.grains) {
    const at = base + grain.atMs / 1000;
    strike(active, cue, at, grain.frequency, spec, { contact: true });
    if (spec.neighbourSemitones !== undefined) {
      strike(active, cue, at, grain.frequency * Math.pow(2, spec.neighbourSemitones / 12), spec, { contact: false });
    }
  }
}

export const sound = {
  /** Fire a cue. Never throws, never awaits, never blocks the interaction. */
  play(cue: SoundCue, opts: SoundPlayOptions = {}): void {
    try {
      playInternal(cue, opts);
    } catch {
      /* audio is decoration - it is never allowed to break the UI */
    }
  },
  /** Patch semantics, as the `Partial` says: merging onto the CURRENT settings
   *  rather than onto the defaults, so `setSettings({ volume })` cannot
   *  silently switch the whole feature back off. */
  setSettings(next: Partial<SoundSettings>): void {
    settings = { ...settings, ...next };
    applyVolume();
    // Copied before iterating: a subscriber is free to unsubscribe from inside
    // its own callback, and mutating the set mid-loop would skip its neighbour.
    for (const subscriber of [...settingsSubscribers]) {
      try {
        subscriber();
      } catch {
        /* a broken subscriber must not stop the settings from applying */
      }
    }
  },
  /** Called whenever the settings change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    settingsSubscribers.add(listener);
    return () => {
      settingsSubscribers.delete(listener);
    };
  },
  isEnabled(): boolean {
    return settings.enabled;
  },
  /** True while the decorative tier should be routed at all. The router uses
   *  this to decide whether to hold its document listeners, not as a per-event
   *  early return (docs/DRILL_PLAN.md B12.10). */
  isDecorativeEnabled(): boolean {
    return settings.enabled && settings.decorative;
  },
  /** See `informationalRaised`. Only meaningful when compared with itself. */
  informationalSeq(): number {
    return informationalRaised;
  }
};

// Chromium caps a page at roughly 6 AudioContexts. Without this, sound dies
// silently after ~6 hot reloads while tuning (B12.10) - the module reloads,
// asks for a seventh context and quietly gets nothing.
import.meta.hot?.dispose(() => {
  const closing = engine;
  engine = null;
  ringing.clear();
  lastHoverAt = 0;
  if (closing) void closing.ctx.close().catch(() => undefined);
});
