/**
 *  Decorative sound routing (docs/DRILL_PLAN.md B12.10, commit 2 of 2).
 *
 *  Two delegated listeners on `document` decide what every click and hover in
 *  the app sounds like. Delegation rather than a few hundred onClick edits: the
 *  renderer is ~16k lines and the mapping is a presentation concern, so putting
 *  a `sound.play` next to every button would spread one design decision across
 *  the entire component tree and go stale the moment anyone adds a button. The
 *  informational cues stay as explicit call sites, because those are semantic -
 *  only the code raising them knows a run finished.
 *
 *  CAPTURE PHASE, deliberately. React 18 attaches its listeners to the root
 *  container, so a bubble-phase document listener would run AFTER React had
 *  already re-rendered the element. `aria-checked` and `aria-expanded` would
 *  read as the post-click state, and every toggle would sound like the thing it
 *  just stopped being. Capture runs before the root container is reached, so
 *  those attributes still describe the state the user was looking at when they
 *  decided to click.
 *
 *  ONE ACTION, ONE SOUND. The cue is RESOLVED in capture (for the pre-click
 *  state) but PLAYED from a microtask, because the two facts needed to decide
 *  whether it should sound at all arrive at different moments - see
 *  `handleClick`.
 */

import { type DecorativeCue, sound } from "./sound";

/** Elements a click can be attributed to. Anything not inside one of these is
 *  silent: clicking a paragraph or the page background is not an interaction. */
const CLICK_TARGETS = 'button, a[href], [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="switch"]';

/** Hover is narrower than click on purpose. It covers the real controls plus
 *  the app's own row classes (rows are divs with handlers, not buttons), and
 *  nothing else, so drifting across body text stays silent. */
const HOVER_TARGETS = [
  CLICK_TARGETS,
  ".nav-row",
  ".project-conversation-row",
  ".project-row-wrap",
  ".memory-tree-row",
  ".registry-row",
  ".healthsweep-row",
  ".router-option",
  ".router-preset-row",
  ".palette-item",
  ".permission-card",
  ".todo-card-main"
].join(", ");

/** Never sound while the pointer is in a field. Typing, dragging a slider and
 *  picking from a native select are all interactions the user is watching
 *  closely, and a tick per keystroke or per slider step is the exact texture
 *  this whole design is trying not to have.
 *
 *  `contenteditable` is matched with the `false` case excluded: a bare
 *  `[contenteditable]` also matches `contenteditable="false"`, which is the
 *  attribute used to make a region explicitly NOT a field, so the naive
 *  selector silences the exact elements it should leave alone. */
const FIELD_TARGETS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** How far the pointer may travel between pressing and releasing and still count
 *  as a click rather than a drag, in CSS px (Manhattan distance, so the hot path
 *  stays to two subtractions and never touches layout).
 *
 *  WHY THIS EXISTS. A drag that starts and ends on the same element fires a
 *  `click` at the end of it, so without this, dragging a graph node around the
 *  canvas (App.tsx ~8987 - an `<article role="button">` with a pointerdown drag
 *  handler) ticks on every drop. Dragging is the one gesture the hint line in
 *  Settings promises is silent, and a slider is only silent today because it
 *  happens to be an `<input>`. 6px sits just above the usual few px of hand
 *  tremor in a real click (docs/DRILL_PLAN.md B12.10). */
const DRAG_SLOP_PX = 6;

/** A hover cue this soon after a click is almost never the user's hand arriving
 *  somewhere: it is a popover or a menu opening UNDER a stationary pointer,
 *  which fires pointerover on the newly hit-tested elements. Sounding it turns
 *  one click into a click plus a tick. Hover is the most expendable tier, so it
 *  yields (docs/DRILL_PLAN.md B12.10). */
const HOVER_AFTER_CLICK_MS = 200;

type ClickRule = {
  /** Matched against the element's own classList. */
  classes?: string[];
  /** Matched with `element.matches`, for attribute and ancestor shapes that a
   *  class name cannot express. */
  selector?: string;
  /** A function when the PRE-click DOM state picks between two cues. */
  cue: DecorativeCue | ((element: Element) => DecorativeCue);
};

function isOn(element: Element, attribute: string): boolean {
  return element.getAttribute(attribute) === "true";
}

/**
 *  Ordered most specific first. The order in THIS array is the priority, and
 *  that is the whole point of it being an array.
 *
 *  THE BUG THIS SHAPE AVOIDS: the obvious implementation loops over the
 *  element's classList on the outside and asks "does any rule want this class",
 *  which quietly makes the order classes were WRITTEN IN in the JSX the thing
 *  that decides priority. `className="send-btn stop-btn"` (App.tsx ~5757, the
 *  composer button while a run is streaming) would then match `send-btn` first
 *  and the abort would sound like a send - the one moment the two must not be
 *  confusable. Iterating rules on the outside means `stop-btn` is checked before
 *  `send-btn` because it sits above it here, and no amount of reordering class
 *  names in the JSX can change that (docs/DRILL_PLAN.md B12.10).
 */
const CLICK_RULES: ClickRule[] = [
  // Toggles first: a switch is also a button, and `.toggle-switch` sometimes
  // carries an `on` class too, so anything matching this is never anything else.
  {
    selector: '[role="switch"], [aria-checked]',
    classes: ["toggle-switch"],
    // PRE-click state: aria-checked is what it WAS, so a checked switch being
    // clicked is being switched off.
    cue: (element) => (isOn(element, "aria-checked") ? "toggleOff" : "toggleOn")
  },
  // Above the primary rule so `send-btn stop-btn` cannot sound like a send.
  // Stopping a run is not a primary action, it is a retraction of one.
  { classes: ["stop-btn"], cue: "click" },
  {
    classes: ["nav-row"],
    selector: '.sidebar-nav button, .settings-nav-group button, [role="tab"]',
    cue: "navSwitch"
  },
  { classes: ["send-btn", "primary-action", "primary", "publish-primary"], selector: '[type="submit"]', cue: "clickPrimary" },
  {
    selector: "[aria-expanded]",
    // Same PRE-click reasoning as the switch: expanded now means this click is
    // the one closing it.
    cue: (element) => (isOn(element, "aria-expanded") ? "popoverClose" : "popoverOpen")
  }
];

function isDisabled(element: Element): boolean {
  if (element.hasAttribute("disabled") || isOn(element, "aria-disabled")) return true;
  // A disabled ancestor disables everything inside it, and a click on a child
  // span of a disabled button reports the button as the target anyway - but
  // fieldsets and disabled rows wrap live-looking children, so walk up.
  return element.closest("[disabled], [aria-disabled=true]") !== null;
}

function matchesRule(element: Element, rule: ClickRule): boolean {
  if (rule.classes) {
    // classList on the INSIDE. See CLICK_RULES for why this direction matters.
    for (const className of rule.classes) {
      if (element.classList.contains(className)) return true;
    }
  }
  if (rule.selector) {
    try {
      if (element.matches(rule.selector)) return true;
    } catch {
      /* a malformed selector must not break clicking */
    }
  }
  return false;
}

function cueForClick(element: Element): DecorativeCue {
  for (const rule of CLICK_RULES) {
    if (!matchesRule(element, rule)) continue;
    return typeof rule.cue === "function" ? rule.cue(element) : rule.cue;
  }
  return "click";
}

/** The last element hovered, so the cue fires on ENTERING a control and not
 *  once per descendant. pointerover bubbles, so moving from a button onto the
 *  icon inside it fires again with a different target that resolves to the same
 *  control - without this, one button could tick three times. */
let lastHovered: Element | null = null;
let lastClickAt = 0;
let pointerDownX = 0;
let pointerDownY = 0;

function handlePointerDown(event: PointerEvent): void {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
}

function handleClick(event: MouseEvent): void {
  // Programmatic clicks - `.click()` from our own code, or a test driving the
  // UI - are not the user's hand landing on anything.
  if (!event.isTrusted) return;
  // Recorded even for clicks that end up silent: a click that opens a popover
  // over a plain div still moves the interface under the pointer, and it is the
  // MOVEMENT, not the sound, that hover has to be told to ignore.
  lastClickAt = Date.now();
  // `detail` is 0 for a keyboard activation (Enter or Space on a focused
  // button), which reports no meaningful coordinates - there is no drag to
  // detect, so the slop test is skipped rather than fed zeroes.
  if (event.detail > 0 && Math.abs(event.clientX - pointerDownX) + Math.abs(event.clientY - pointerDownY) > DRAG_SLOP_PX) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) return;
  const element = target.closest(CLICK_TARGETS);
  if (!element || isDisabled(element)) return;
  if (target.closest(FIELD_TARGETS)) return;

  // Resolve NOW (capture phase, pre-click attributes) but play LATER.
  //
  // A button that raises its own informational cue must not ALSO tick: clicking
  // send would otherwise play clickPrimary and then the `send` figure, and
  // arming a delete would play a bright click over a cue whose whole point is
  // that it is dead and dark. The router cannot know which buttons those are
  // without duplicating the call sites it exists to avoid - but it does not have
  // to, because it can simply wait and see. React 18 dispatches its onClick, and
  // any `sound.play` inside it, synchronously within this same task; the
  // microtask queue drains only once that task is finished. So by the time this
  // callback runs, an informational cue for THIS gesture has already been
  // counted, and the decorative one stands down (docs/DRILL_PLAN.md B12.10).
  const seq = sound.informationalSeq();
  const cue = cueForClick(element);
  queueMicrotask(() => {
    if (sound.informationalSeq() !== seq) return;
    sound.play(cue);
  });
}

function handlePointerOver(event: PointerEvent): void {
  if (!event.isTrusted) return;
  // Touch and pen do not hover: their "pointerover" is the first half of a tap,
  // so sounding it would double every touch interaction.
  if (event.pointerType && event.pointerType !== "mouse") return;
  // Cheapest gate first, before any tree walk: see HOVER_AFTER_CLICK_MS.
  if (Date.now() - lastClickAt < HOVER_AFTER_CLICK_MS) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  // HOVER_TARGETS before FIELD_TARGETS, deliberately. Both are `closest` walks
  // to the root, and by far the most common pointerover in this app is one over
  // something that makes no sound at all - body text, padding, a panel edge.
  // Testing the hover match first lets that case cost ONE walk instead of two,
  // which halves the work on the only path here that runs at mouse-move rate.
  const element = target.closest(HOVER_TARGETS);
  if (!element) {
    // Moving onto dead space clears the dedupe, so coming back to the control
    // you just left is a real re-entry and ticks again.
    lastHovered = null;
    return;
  }
  if (element === lastHovered) return;
  // A field nested inside a hover target (an input in a registry row, say)
  // resolves to the row, so the field test still has to happen - just second.
  if (target.closest(FIELD_TARGETS)) {
    lastHovered = null;
    return;
  }
  // Set this BEFORE the play call: a hover dropped by the throttle has still
  // been entered, and re-firing it on the next descendant event would let a
  // single control queue up several attempts at the gate.
  lastHovered = element;
  if (isDisabled(element)) return;
  sound.play("hover");
}

let attached = false;

function attach(): void {
  if (attached) return;
  attached = true;
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("pointerover", handlePointerOver, true);
}

function detach(): void {
  if (!attached) return;
  attached = false;
  document.removeEventListener("pointerdown", handlePointerDown, true);
  document.removeEventListener("click", handleClick, true);
  document.removeEventListener("pointerover", handlePointerOver, true);
  lastHovered = null;
}

/** Follow the settings rather than sitting there returning early forever. With
 *  the tier off - which is the state for anyone who never opts in, i.e. almost
 *  everyone - the app carries NO document-level pointer listener at all, rather
 *  than one that runs a function call per pointerover to decide to do nothing
 *  (docs/DRILL_PLAN.md B12.10). */
function syncToSettings(): void {
  if (sound.isDecorativeEnabled()) attach();
  else detach();
}

/** Install the delegated listeners. Returns the teardown. */
export function installDecorativeSound(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const unsubscribe = sound.subscribe(syncToSettings);
  syncToSettings();
  return () => {
    unsubscribe();
    detach();
  };
}

// The listeners outlive a module reload, so without this a tuning session stacks
// a fresh capture listener per edit and every click plays several times over
// (same class of silent-decay-while-iterating problem as the AudioContext cap
// in sound.ts, docs/DRILL_PLAN.md B12.10).
import.meta.hot?.dispose(() => {
  detach();
});
