// hello: the smallest possible package, used to demonstrate URL imports.

export default function greet(name: string): string {
  return "Hello, " + name + "!";
}

test "greets by name" {
  expect(greet("world")).toBe("Hello, world!");
}
