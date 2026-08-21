// The canvas arithmetic: colour assignment, force-directed layout, geometry.
//
// This decides where a node settles on the orchestration canvas, what colour a
// project gets, and what a click selects. None of it was reachable by a test
// until the App.tsx slice (docs/STRUCTURAL_DEBT.md item 1) moved it out of an
// 18,000-line file that imports React.
//
// The failures here are visual and none of them throw: a canvas that never
// settles, one that jitters forever, a click that selects the wrong edge, a
// project whose colour changes every time you reopen the app. You notice
// eventually and have nothing to point at.
//
// The first version of this file was written against guessed signatures and got
// four of them wrong — `lerp` takes two points rather than two numbers,
// `seedPhysicsNodes` takes and returns Maps, `stepPhysics` wants a drag target
// and a timestep. Rule 3, in a new place: an assumption about an API is a
// hypothesis until the compiler answers.
//
// Offline: no React, no DOM, no provider, no key. It is arithmetic.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const g = await fromBuild("renderer/ui/graph-maths.js");

const SETTINGS = { repelForce: 1, centerForce: 1, linkDistance: 110, linkThickness: 1 };
const node = (id, x, y) => ({ id, label: id, type: "conversation", pos: { x, y } });

section("A project's colour is stable, or every reopen repaints the canvas");
{
  const a = g.hueForKey("metis-orchestrator");
  check("the same key gives the same hue", g.hueForKey("metis-orchestrator"), a);
  ok("different keys generally differ", g.hueForKey("alpha") !== g.hueForKey("beta") || g.hueForKey("alpha") !== g.hueForKey("gamma"));

  // Every result has to be a real hue, including for inputs nobody plans for.
  for (const key of ["", "a", "a".repeat(500), "проект", "🎨", "  "]) {
    const hue = g.hueForKey(key);
    ok(`"${key.slice(0, 10)}" gives a usable hue (${hue})`, Number.isFinite(hue) && hue >= 0 && hue < 360);
  }
}

section("Geometry on points");
{
  const near = (a, b) => Math.abs(a - b) < 0.001;
  check("lerp at 0 is the start", g.lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0), { x: 0, y: 0 });
  check("lerp at 1 is the end", g.lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 1), { x: 10, y: 20 });
  check("lerp halfway", g.lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
  check("and it works backwards", g.lerp({ x: 10, y: 20 }, { x: 0, y: 0 }, 0.5), { x: 5, y: 10 });

  const mid = g.average([{ x: 0, y: 0 }, { x: 10, y: 20 }]);
  ok("average is the midpoint", near(mid.x, 5) && near(mid.y, 10));
  check("one point averages to itself", g.average([{ x: 3, y: 4 }]), { x: 3, y: 4 });

  // A REAL GAP, asserted as the behaviour rather than quietly fixed here.
  // `average` divides by `points.length` with no empty guard, so an empty list
  // gives NaN — and a NaN coordinate puts something nowhere and never recovers.
  // No caller passes an empty list today, which is why it has never bitten.
  // Recorded so that if one ever does, this line says what happens.
  const empty = g.average([]);
  ok("an empty list currently yields NaN, not zero", Number.isNaN(empty.x) && Number.isNaN(empty.y));
}

section("distancePointToSegment — what a click actually selects");
{
  const near = (a, b) => Math.abs(a - b) < 0.001;
  const from = { x: 0, y: 0 };
  const to = { x: 10, y: 0 };

  ok("a point on the segment is distance 0", near(g.distancePointToSegment({ x: 5, y: 0 }, from, to), 0));
  ok("directly above the middle", near(g.distancePointToSegment({ x: 5, y: 3 }, from, to), 3));
  // PAST THE END is what a naive infinite-line formula gets wrong: it would
  // report 0, so clicking far past an edge would select it.
  ok("past the end measures to the endpoint", near(g.distancePointToSegment({ x: 20, y: 0 }, from, to), 10));
  ok("before the start likewise", near(g.distancePointToSegment({ x: -5, y: 0 }, from, to), 5));
  // Two nodes at the same position is real — a graph loaded before layout ran —
  // and a divide-by-zero in the naive formula.
  ok("a zero-length segment does not divide by zero", Number.isFinite(g.distancePointToSegment({ x: 3, y: 4 }, from, from)));
}

section("Seeding puts every node somewhere real");
{
  const nodes = [node("a", 0, 0), node("b", 100, 50), node("c", -40, 90)];
  const degree = new Map([["a", 1], ["b", 2], ["c", 1]]);
  const bodies = g.seedPhysicsNodes(nodes, degree, new Map());

  check("one body per node", bodies.size, 3);
  const list = [...bodies.values()];
  ok("every body has finite coordinates", list.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)));
  ok("and a previous position, since the integrator is verlet", list.every((b) => Number.isFinite(b.px) && Number.isFinite(b.py)));
  ok("ids are preserved", [...bodies.keys()].sort().join(",") === "a,b,c");

  // Prior positions are reused so a re-render does not restart the layout and
  // throw the canvas around while you are looking at it.
  const prior = g.seedPhysicsNodes(nodes, degree, bodies);
  const before = bodies.get("b");
  const after = prior.get("b");
  ok("an existing body keeps its position across a reseed", after.x === before.x && after.y === before.y);

  check("no nodes seeds nothing", g.seedPhysicsNodes([], new Map(), new Map()).size, 0);
}

section("The simulation settles, and never produces a NaN");
{
  const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i}`, i * 7, (i % 4) * 11));
  const links = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  const degree = new Map(nodes.map((n) => [n.id, links.filter((l) => l.from === n.id || l.to === n.id).length]));
  const bodies = g.seedPhysicsNodes(nodes, degree, new Map());

  let energy = Infinity;
  for (let i = 0; i < 600; i++) energy = g.stepPhysics(bodies, links, SETTINGS, null, 1 / 60);

  const list = [...bodies.values()];
  // A NaN coordinate is unrecoverable: the node is nowhere, stays nowhere, and
  // nothing throws to say so.
  ok("every coordinate is finite after 600 steps", list.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)));
  ok("the reported energy is finite", Number.isFinite(energy));
  // The whole point of a sleep threshold: a canvas that never settles burns a
  // frame budget forever.
  ok(`it settles below the sleep threshold (${energy.toFixed(5)} < ${g.GRAPH_KINETIC_SLEEP_THRESHOLD})`, energy < g.GRAPH_KINETIC_SLEEP_THRESHOLD);
}

section("Coincident nodes do not explode");
{
  // Two nodes on the exact same spot is a divide-by-zero in every repulsion
  // formula. It happens: two seeded from the same saved position.
  const nodes = [node("a", 50, 50), node("b", 50, 50)];
  const degree = new Map([["a", 0], ["b", 0]]);
  const bodies = g.seedPhysicsNodes(nodes, degree, new Map());
  for (let i = 0; i < 50; i++) g.stepPhysics(bodies, [], SETTINGS, null, 1 / 60);
  ok("both are still finite", [...bodies.values()].every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)));
}

section("The node being dragged is not fought by the simulation");
{
  const nodes = [node("a", 0, 0), node("b", 200, 0)];
  const links = [{ from: "a", to: "b" }];
  const degree = new Map([["a", 1], ["b", 1]]);
  const bodies = g.seedPhysicsNodes(nodes, degree, new Map());

  const dragged = bodies.get("a");
  dragged.x = 500;
  dragged.y = 500;
  const heldX = dragged.x;
  const heldY = dragged.y;
  for (let i = 0; i < 60; i++) g.stepPhysics(bodies, links, SETTINGS, "a", 1 / 60);

  // Dragging a node and having the layout pull it out from under the cursor is
  // the bug this prevents, and it is the kind you blame on your own mouse.
  ok("the dragged node stays where it was put", bodies.get("a").x === heldX && bodies.get("a").y === heldY);
  ok("while the other one responds", bodies.get("b").x !== 200 || bodies.get("b").y !== 0);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
