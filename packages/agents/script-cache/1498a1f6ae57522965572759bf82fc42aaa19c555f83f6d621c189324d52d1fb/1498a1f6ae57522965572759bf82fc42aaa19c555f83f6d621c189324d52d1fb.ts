// --- given by the workflow ------------------------------------------
// These are the step's inputs. Everything else is up to you; there is
// no network, no environment, and no file outside this directory.
function given(name: string): string {
  try { return fs.readFileSync(name); } catch (e) { return ""; }
}
/** The previous step's answer. */
function prev(): string { return given("prev"); }
/** What the run was started with. */
function input(): string { return given("input"); }
/** Any earlier step's answer, by the id the drawing gives it. */
function node(id: string): string { return given("node-" + id); }
// --------------------------------------------------------------------
function main(): void {
  let s = "";
  let i: int = 0;
  while (i < 30000) { s = s + "0123456789"; i = i + 1; }
  console.log(s);
}
main();