# mathx

Integer math helpers.

| Function | Signature |
|----------|-----------|
| `gcd` | `(a: int, b: int) => int` |
| `lcm` | `(a: int, b: int) => int` |
| `ipow` | `(base: int, exp: int) => int` |
| `isPrime` | `(n: int) => bool` |
| `clampInt` | `(v: int, lo: int, hi: int) => int` |

```ts
console.log(gcd(12, 8));     // 4
console.log(ipow(2, 10));    // 1024
console.log(isPrime(13));    // true
```

Test: `lumen test packages/mathx/mathx.ts`
