# geo

2D point helpers.

```ts
interface Point { x: int; y: int; }
```

| Function | Signature |
|----------|-----------|
| `distanceSq` | `(a: Point, b: Point) => int` |
| `manhattan` | `(a: Point, b: Point) => int` |

```ts
let o: Point = { x: 0, y: 0 };
let p: Point = { x: 3, y: 4 };
console.log(distanceSq(o, p));   // 25
```

Test: `lumen test packages/geo/geo.ts`
