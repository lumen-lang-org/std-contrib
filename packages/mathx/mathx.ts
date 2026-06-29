// mathx — integer math helpers.
//
// V1 note: until multi-symbol module imports land, the library functions and
// their tests live in one file. Run: lumen test packages/mathx/mathx.ts

function gcd(a: int, b: int): int {
  let x = a;
  let y = b;
  while (y != 0) {
    let t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function lcm(a: int, b: int): int {
  return a / gcd(a, b) * b;
}

function ipow(base: int, exp: int): int {
  let result = 1;
  let i = 0;
  while (i < exp) {
    result = result * base;
    i += 1;
  }
  return result;
}

function isPrime(n: int): bool {
  if (n < 2) {
    return false;
  }
  let i = 2;
  while (i * i <= n) {
    if (n % i == 0) {
      return false;
    }
    i += 1;
  }
  return true;
}

function clampInt(v: int, lo: int, hi: int): int {
  if (v < lo) {
    return lo;
  }
  if (v > hi) {
    return hi;
  }
  return v;
}

test("gcd and lcm", () => {
  expect(gcd(12, 8) == 4);
  expect(gcd(17, 5) == 1);
  expect(lcm(4, 6) == 12);
});

test("ipow, isPrime, clampInt", () => {
  expect(ipow(2, 10) == 1024);
  expect(isPrime(13));
  expect(!isPrime(9));
  expect(clampInt(20, 0, 10) == 10);
  expect(clampInt(-3, 0, 10) == 0);
});
