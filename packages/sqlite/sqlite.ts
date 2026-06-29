// A typed wrapper over SQLite, backed by a small C shim (sqlite_shim.c).
// @link ./sqlite_shim.o
// @link sqlite3
// @link c
// On the wasm target there is no native linking: the compiler fetches this
// prebuilt archive (the shim + the SQLite amalgamation, compiled to wasm32-wasi)
// and links it in, so the program is a single self-contained wasm. Rebuild it
// with ./build-wasm.sh. In-memory databases (":memory:") need no host fs.
// @wasm-link https://github.com/lumen-lang-org/std-contrib/releases/download/wasm-engines-v1/sqlite-wasm.a#sha256=42c8e34f4a6379272ed158b3b8d761f04569b4b897da8ea9e543348dc24bcb1f
declare function db_open(path: string): int;
declare function db_exec(sql: string): int;
declare function db_query_int(sql: string): int;
declare function db_query_text(sql: string): string;
declare function db_errmsg(): string;
declare function db_close(): int;

export function open(path: string): int {
  return db_open(path);
}
export function exec(sql: string): int {
  return db_exec(sql);
}
export function queryInt(sql: string): int {
  return db_query_int(sql);
}
export function queryText(sql: string): string {
  return db_query_text(sql);
}
export function errorMessage(): string {
  return db_errmsg();
}
export function close(): int {
  return db_close();
}
