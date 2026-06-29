// geo — 2D point helpers.
//
// Run: lumen test packages/geo/geo.ts

interface Point {
  x: int;
  y: int;
}

function distanceSq(a: Point, b: Point): int {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function manhattan(a: Point, b: Point): int {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  return Math.abs(dx) + Math.abs(dy);
}

test("distanceSq", () => {
  let o: Point = { x: 0, y: 0 };
  let p: Point = { x: 3, y: 4 };
  expect(distanceSq(o, p) == 25);
});

test("manhattan", () => {
  let a: Point = { x: 1, y: 1 };
  let b: Point = { x: 4, y: 5 };
  expect(manhattan(a, b) == 7);
});
