/** The orchestration canvas's arithmetic: colour assignment, force-directed
 *  layout, and the geometry a route line is drawn from.
 *
 *  Second slice of the App.tsx work in docs/STRUCTURAL_DEBT.md item 1, and the
 *  first from the helper category — 112 hook-free, bridge-free functions
 *  totalling 1,781 lines, of which this is 228.
 *
 *  Two ranges of `App.tsx` that were 8,000 lines apart and are the same subject:
 *  the physics that decides where a node settles, and the geometry that decides
 *  where the line between two nodes goes. Both measured at **zero** dependencies
 *  on the rest of the file, which is what makes this a file move rather than a
 *  refactor. Nothing here touches React — no hook, no state, no JSX — so there
 *  is nothing to inject and nothing to thread.
 *
 *  Worth testing rather than merely moving, which is why it went first among the
 *  helpers: `stepPhysics` is 81 lines of iterative force integration with a
 *  sleep threshold, and the failure mode of getting it wrong is a canvas that
 *  never settles or one that jitters forever. `distancePointToSegment` decides
 *  what a click selects. `hueForKey` has to be stable across runs or every
 *  project changes colour when you reopen the app.
 */

/** Structural twins of App.tsx's canvas types. Measured rather than assumed:
 *  across all 228 lines moved here, the only node fields touched are .id and
 *  .pos. Importing the real GraphNode would mean importing App.tsx back and
 *  making a cycle, and it would drag NodeKind, ProviderId and NodeModelSlot
 *  along for two fields. TypeScript matches by shape. */
export type Vec = { x: number; y: number };
type GraphNode = { id: string; pos: Vec };

/** Physics body for the force-directed Graph View sim — verlet-integrated,
 *  and in sim-space rather than screen pixels. */
export type PhysicsNode = {
  id: string;
  x: number;
  y: number;
  px: number;
  py: number;
  degree: number;
  pinned: boolean;
  radius: number;
};

export type MemoryGraphLink = { from: string; to: string; strength?: number };

export type GraphPhysicsSettings = {
  repelForce: number;
  centerForce: number;
  linkDistance: number;
  linkThickness: number;
};

export type RouteSegment = { from: Vec; to: Vec };
/** The node kinds the memory graph draws. A twin of App.tsx's union rather
 *  than an import: this file only ever compares it, never constructs one. */
type MemoryNodeType = string;

export type MemoryGraphNode = {
  id: string;
  label: string;
  type: MemoryNodeType;
  pos: Vec;
  size?: number;
  detail?: string;
  conversationId?: string;
  runId?: string;
  operationId?: string;
  path?: string;
};

export type ColorRule = { id: string; match: (node: MemoryGraphNode) => boolean; color: string; label: string };

/** The muted hues a project key is assigned from, in order. hueForKey's own
 *  data — its only consumer is the function below it. */
const GRAPH_HUE_RAMP = [210, 265, 25, 160, 320, 45];

/** Assigns a project (or other grouping key) a stable muted hue from GRAPH_HUE_RAMP, so the same project always gets the same color group. */
export function hueForKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return GRAPH_HUE_RAMP[hash % GRAPH_HUE_RAMP.length];
}

/** Base built-in color-group rules: packages first (distinct base tone), then per-project hues, falling back to node-type greys. A rule is {match, color} so query-based rules can slot in later without touching the renderer.
 *  Owner feedback (docs/FABLE_PLANS.md section 17): the hue ramp is OPT-IN via the graph settings
 *  "Colour by project" toggle (default off) — when disabled this returns no rules at all, so every
 *  node falls through to the sleek-dark greyscale in colorForNode(). */
export function buildColorRules(graphNodes: MemoryGraphNode[], colorByProject: boolean): ColorRule[] {
  if (!colorByProject) return [];
  const projectKeys = new Set<string>();
  for (const node of graphNodes) {
    if (node.type === "project") projectKeys.add(node.id);
  }
  const rules: ColorRule[] = [
    { id: "package", match: (node) => node.type === "file" && node.detail === "installed package", color: "hsl(45 55% 58%)", label: "Packages" }
  ];
  for (const key of projectKeys) {
    rules.push({
      id: `project:${key}`,
      match: (node) => node.id === key || node.path?.includes(key) === true,
      color: `hsl(${hueForKey(key)} 38% 58%)`,
      label: key
    });
  }
  return rules;
}

/** Obsidian-style light body fill on the dark canvas — colour (when the opt-in "Colour by
 *  project" rule matches) is the only source of hue; otherwise every node reads as a light
 *  grey/white whose brightness ramps with degree (dimmer for low-degree leaves, brighter for
 *  hubs), landing in the #b9bdc6–#d8dade range per owner feedback (2026-07-03 batch, §18). */
export function colorForNode(node: MemoryGraphNode, rules: ColorRule[], degree = 0): string {
  for (const rule of rules) {
    if (rule.match(node)) return rule.color;
  }
  const t = Math.max(0, Math.min(1, degree / 6));
  const lightness = 74 + t * 10; // 74% (#b9bdc6-ish) -> 84% (#d8dade-ish)
  return `hsl(228 8% ${lightness}%)`;
}

export const GRAPH_KINETIC_SLEEP_THRESHOLD = 0.015;
const GRAPH_DAMPING = 0.86;

/** Seeds physics bodies for a node set, reusing prior positions/velocity where the id already existed (keeps the sim continuous across data refreshes). */
export function seedPhysicsNodes(graphNodes: MemoryGraphNode[], degree: Map<string, number>, prior: Map<string, PhysicsNode>): Map<string, PhysicsNode> {
  const next = new Map<string, PhysicsNode>();
  graphNodes.forEach((node, index) => {
    const existing = prior.get(node.id);
    const d = degree.get(node.id) ?? 0;
    // Obsidian-style nodes read smaller than the old dark-fill design (~60-70% of prior radii).
    const radius = Math.max(4, Math.min(20, 4 + d * 1.6 + (node.size ?? 18) * 0.17));
    if (existing) {
      next.set(node.id, { ...existing, degree: d, radius });
      return;
    }
    const angle = (index / Math.max(1, graphNodes.length)) * Math.PI * 2;
    const spread = 90 + (index % 7) * 40;
    const x = node.pos.x || Math.cos(angle) * spread;
    const y = node.pos.y || Math.sin(angle) * spread;
    next.set(node.id, { id: node.id, x, y, px: x, py: y, degree: d, pinned: false, radius });
  });
  return next;
}

/**
 * One verlet-integration physics step for the Graph View force sim (Obsidian-style):
 * pairwise Coulomb-ish repulsion (capped, O(n^2) — fine at the hundreds-of-nodes scale this view sees),
 * spring attraction along edges toward `linkDistance`, and gravity pulling every free node toward the origin.
 * Returns the total kinetic energy so the caller can decide whether the sim should keep animating or sleep.
 */
export function stepPhysics(
  nodes: Map<string, PhysicsNode>,
  links: MemoryGraphLink[],
  settings: GraphPhysicsSettings,
  draggingId: string | null,
  dt: number
): number {
  const list = Array.from(nodes.values());
  const forces = new Map<string, Vec>(list.map((n) => [n.id, { x: 0, y: 0 }]));

  // Pairwise repulsion (Coulomb-ish, capped so close overlaps don't blow up).
  const repelK = 2600 * settings.repelForce;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        distSq = 1;
      }
      const dist = Math.sqrt(distSq);
      const force = Math.min(120, repelK / distSq);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      forces.get(a.id)!.x += fx;
      forces.get(a.id)!.y += fy;
      forces.get(b.id)!.x -= fx;
      forces.get(b.id)!.y -= fy;
    }
  }

  // Spring attraction along edges toward the target link distance.
  const springK = 0.045;
  for (const link of links) {
    const a = nodes.get(link.from);
    const b = nodes.get(link.to);
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const target = settings.linkDistance * (link.strength ? 1 / Math.min(2, link.strength) : 1);
    const delta = (dist - target) * springK;
    const fx = (dx / dist) * delta;
    const fy = (dy / dist) * delta;
    forces.get(a.id)!.x += fx;
    forces.get(a.id)!.y += fy;
    forces.get(b.id)!.x -= fx;
    forces.get(b.id)!.y -= fy;
  }

  // Center gravity — keeps free nodes from drifting off into the void.
  const gravityK = 0.0022 * settings.centerForce;
  for (const node of list) {
    forces.get(node.id)!.x += -node.x * gravityK;
    forces.get(node.id)!.y += -node.y * gravityK;
  }

  let kinetic = 0;
  for (const node of list) {
    if (node.id === draggingId) {
      node.px = node.x;
      node.py = node.y;
      continue;
    }
    const f = forces.get(node.id)!;
    const vx = (node.x - node.px) * GRAPH_DAMPING + f.x * dt * dt;
    const vy = (node.y - node.py) * GRAPH_DAMPING + f.y * dt * dt;
    node.px = node.x;
    node.py = node.y;
    node.x += vx;
    node.y += vy;
    kinetic += vx * vx + vy * vy;
  }
  return kinetic;
}

/** Builds the neighbor-depth filter for local graph mode: BFS out from `rootId` up to `depth` hops. */
export function localGraphIds(rootId: string, links: MemoryGraphLink[], depth: number): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    (adjacency.get(link.from) ?? adjacency.set(link.from, []).get(link.from)!).push(link.to);
    (adjacency.get(link.to) ?? adjacency.set(link.to, []).get(link.to)!).push(link.from);
  }
  const visited = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

export function routeSegments(routerPos: Vec, agent: GraphNode, skillIds: string[], resolve: (id: string) => Vec): RouteSegment[] {
  const skillPositions = skillIds.map(resolve);
  if (skillPositions.length === 0) return [{ from: routerPos, to: agent.pos }];
  if (skillPositions.length === 1) return [{ from: routerPos, to: skillPositions[0] }, { from: skillPositions[0], to: agent.pos }];

  const center = average(skillPositions);
  const split = lerp(routerPos, center, 0.55);
  const merge = lerp(agent.pos, center, 0.55);
  return [
    { from: routerPos, to: split },
    ...skillPositions.map((pos) => ({ from: split, to: pos })),
    ...skillPositions.map((pos) => ({ from: pos, to: merge })),
    { from: merge, to: agent.pos }
  ];
}

export function average(points: Vec[]): Vec {
  const total = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

export function distancePointToSegment(point: Vec, from: Vec, to: Vec): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

export function normalizeMemoryLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function extnameLower(path: string): string {
  const match = /\.[^./\\]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

export function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function curve(a: Vec, b: Vec): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return `M ${a.x} ${a.y} C ${a.x + dx * 0.5} ${a.y} ${b.x - dx * 0.5} ${b.y} ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy * 0.5} ${b.x} ${b.y - dy * 0.5} ${b.x} ${b.y}`;
}
