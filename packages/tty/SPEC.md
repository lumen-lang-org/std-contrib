# std-contrib package: `tty`

**Status**: Draft | **Depends on**: FFI scalar marshalling (compiler feature 009)

Raw-mode terminal input and control via the C FFI: enough to build a real
TUI, not just detect a keypress. POSIX `termios` and `ioctl(TIOCGWINSZ)`
control a terminal through structs, and Lumen's FFI marshals only scalars
(009) and strings (023) across the C boundary — not structs, and `Ref<T>`
is explicitly disallowed on FFI parameters too (spec 024: `E_FFI_TYPE`) — so
`tty_shim.c` keeps every struct on the C side and exposes plain int-in/int-out
functions; `tty.ts` declares them, adds key decoding and ANSI helpers on top,
and exports a typed API. Single fd's raw-mode state saved at a time, matching
the single-connection style `packages/sqlite` already uses.

## API

Raw mode / I/O: `isatty(fd): bool`, `rawEnable(fd): bool`, `rawDisable(fd): bool`,
`readByte(fd): int`, `readByteTimeout(fd, timeoutMs): int`.

Terminal size: `cols(fd): int`, `rows(fd): int` — two scalar-returning calls,
not one call with two out-params, since `Ref<T>` cannot cross the FFI
boundary.

Key decoding: `readKey(fd): Key` where `Key = { kind: string, char: string }`;
kind constants `KEY_CHAR`, `KEY_ENTER`, `KEY_BACKSPACE`, `KEY_TAB`,
`KEY_ESCAPE`, `KEY_CTRL_C`, `KEY_CTRL_D`, `KEY_ARROW_UP`, `KEY_ARROW_DOWN`,
`KEY_ARROW_LEFT`, `KEY_ARROW_RIGHT`, `KEY_EOF`, `KEY_UNKNOWN`.

Cursor/screen (pure Lumen strings, no FFI): `ENTER_ALT_SCREEN`,
`EXIT_ALT_SCREEN`, `HIDE_CURSOR`, `SHOW_CURSOR`, `CLEAR_SCREEN`, `CLEAR_LINE`,
`cursorTo(row, col)`, `cursorUp(n)`, `cursorDown(n)`, `cursorToColumn(col)`.

## Why not zig-spoon

Considered first. Dropped: GPLv3, unlike every other native dependency in
this repo (SQLite is public domain, QuickJS is MIT). Linking a GPLv3 library
would put GPLv3 obligations on any program that imports this package. Since
Lumen's FFI only exposes scalars to begin with, a richer library's API
couldn't be exposed past that boundary anyway — the value it would have added
(structured key-event types) is what `readKey` now provides directly, in pure
Lumen and this shim, under the same license as the rest of this repo.

## Escape-sequence disambiguation

Detecting a lone Escape keypress versus the start of an arrow-key sequence
(`ESC [ A`) needs a short read timeout after seeing `0x1B`, since a blocking
read cannot tell "nothing more is coming" from "more is coming, just not yet."
`tty_read_byte_timeout` uses `poll()` with a 50ms window for this. `readByte`
alone (no timeout) is left as the primitive for callers that already know
how many bytes to expect.

## Linking

`// @link ./tty_shim.o`. Built locally:

```sh
cc -c tty_shim.c -o tty_shim.o
```

System headers only: `termios.h`, `unistd.h`, `fcntl.h`, `sys/ioctl.h`,
`poll.h`. No system library beyond libc.

## Out of scope (future)

Mouse events. Function keys, Home/End/PageUp/PageDown/Delete (only the four
arrow keys are decoded — extending `readEscapeSequence` to more sequences is
straightforward if a consumer needs them). Multiple fds' raw-mode state at
once. Non-blocking/poll-driven event loop integration beyond the one timeout
primitive `readKey` needs internally.

wasm32-wasi is not supported: WASI has no terminal ioctl/termios surface, so
raw mode and terminal size are meaningless in that sandbox.
