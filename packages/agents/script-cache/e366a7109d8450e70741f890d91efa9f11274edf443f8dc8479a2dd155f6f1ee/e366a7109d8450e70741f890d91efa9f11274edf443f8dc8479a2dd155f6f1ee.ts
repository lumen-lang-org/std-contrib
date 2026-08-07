// Count how many keys the previous step's answer had.
function main(): void {
  let given = fs.readFileSync("input.json");
  let n: int = 0;
  let i: int = 0;
  while (i < given.length) {
    if (given.charAt(i) == ":") { n = n + 1; }
    i = i + 1;
  }
  console.log("colons in what I was given: " + `${n}`);
}
main();
