// args — command-line flag and option parsing.
//
// Two layers:
//   hasFlag/optionValue/positional      — read the process arguments directly
//   hasFlagIn/optionValueIn/positionalIn — pure, operate on an explicit string[]
//                                          (used by the tests; argv[0] is the
//                                          program name, as in C)
//
// Run: lumen test packages/args/args.ts

// --- runtime API: reads the process arguments ---

function hasFlag(name: string): bool {
  let i = 0;
  while (i < argsCount()) {
    if (arg(i) == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function optionValue(name: string, fallback: string): string {
  let i = 0;
  while (i < argsCount()) {
    if (arg(i) == name) {
      if (i + 1 < argsCount()) {
        return arg(i + 1);
      }
      return fallback;
    }
    i = i + 1;
  }
  return fallback;
}

function positional(index: int): string {
  let count = 0;
  let i = 0;
  while (i < argsCount()) {
    let a = arg(i);
    if (!String.startsWith(a, "-")) {
      if (count == index) {
        return a;
      }
      count = count + 1;
    }
    i = i + 1;
  }
  return "";
}

// --- pure core: operate on an explicit argv (unit-tested) ---

function hasFlagIn(argv: string[], name: string): bool {
  for (const a of argv) {
    if (a == name) {
      return true;
    }
  }
  return false;
}

function optionValueIn(argv: string[], name: string, fallback: string): string {
  let take = false;
  for (const a of argv) {
    if (take) {
      return a;
    }
    if (a == name) {
      take = true;
    }
  }
  return fallback;
}

function positionalIn(argv: string[], index: int): string {
  let count = 0;
  for (const a of argv) {
    if (!String.startsWith(a, "-")) {
      if (count == index) {
        return a;
      }
      count = count + 1;
    }
  }
  return "";
}

test("hasFlagIn", () => {
  let argv: string[] = ["build", "--verbose", "--out", "a.bin"];
  expect(hasFlagIn(argv, "--verbose"));
  expect(!hasFlagIn(argv, "--quiet"));
});

test("optionValueIn", () => {
  let argv: string[] = ["build", "--out", "a.bin"];
  expect(optionValueIn(argv, "--out", "x") == "a.bin");
  expect(optionValueIn(argv, "--missing", "def") == "def");
  let trailing: string[] = ["--out"];
  expect(optionValueIn(trailing, "--out", "def") == "def");
});

test("positionalIn", () => {
  let argv: string[] = ["--verbose", "input.ts", "extra"];
  expect(positionalIn(argv, 0) == "input.ts");
  expect(positionalIn(argv, 1) == "extra");
  expect(positionalIn(argv, 2) == "");
});
