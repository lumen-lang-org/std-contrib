# tty

Raw-mode terminal input and control for Lumen programs: raw mode, key
decoding, terminal size, and ANSI cursor/screen control. Enough to build a
real TUI (persistent input region, scrollback, in-place redraw), not just
single-keypress detection.

By default a terminal is in "cooked" mode: the OS buffers input a line at a
time and only hands it to your program once Enter is pressed — this is what
`readline.question` relies on. Raw mode delivers bytes as they're typed,
`readKey` turns those bytes into decoded keypresses (arrow keys, Enter,
Backspace, Ctrl-C, UTF-8 characters, ...), and the ANSI helpers let you
redraw in place instead of only ever scrolling.

## Why a shim

`termios` and `ioctl(TIOCGWINSZ)` settings live in structs, and Lumen's FFI
only marshals scalars and strings across the C boundary (`Ref<T>` is
disallowed on FFI parameters too, see `SPEC.md`). `tty_shim.c` keeps every
struct entirely on the C side and hands Lumen only scalar in/out functions.
Cursor movement and the alternate screen need no FFI at all: they're ANSI
escape sequences, plain strings written to stdout.

## Usage

```ts
import { isatty, rawEnable, rawDisable, readKey, KEY_CTRL_C, KEY_ENTER, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from
  "https://lumen-lang.org/package/std-contrib/tty/tty.ts";

const STDIN = 0;

if (isatty(STDIN)) {
  console.log(ENTER_ALT_SCREEN);
  rawEnable(STDIN);
  const k = readKey(STDIN);
  if (k.kind == KEY_CTRL_C) {
    console.log("cancelled");
  } else if (k.kind == KEY_ENTER) {
    console.log("submitted");
  }
  rawDisable(STDIN);
  console.log(EXIT_ALT_SCREEN);
}
```

Always pair a successful `rawEnable` with a `rawDisable`, and `ENTER_ALT_SCREEN`
with `EXIT_ALT_SCREEN`, before the program exits — otherwise the user's shell
is left in raw mode or on the alternate screen.

## API

Raw mode and byte I/O:

- `isatty(fd: int): bool` — is `fd` connected to a terminal?
- `rawEnable(fd: int): bool` — switch `fd` to raw mode. `false` if `fd` isn't
  a terminal.
- `rawDisable(fd: int): bool` — restore the settings from the last
  `rawEnable`. `false` if nothing was enabled.
- `readByte(fd: int): int` — block for exactly one byte. `-1` at EOF, `-2` on
  a read error, otherwise the byte's value (0-255).
- `readByteTimeout(fd: int, timeoutMs: int): int` — as `readByte`, plus `-3`
  if the timeout elapses with nothing available.

Terminal size:

- `cols(fd: int): int`, `rows(fd: int): int` — current width/height. `-1` if
  `fd` isn't a terminal. Two calls rather than one, since `Ref<T>` cannot
  carry the two values out through an FFI parameter (spec 024).

Key decoding:

- `readKey(fd: int): Key` — blocks for one keypress and decodes it: the
  arrow keys, Enter, Backspace, Tab, Ctrl-C, Ctrl-D, a lone Escape (nothing
  follows within 50ms), a UTF-8 character (1-4 bytes), or `KEY_UNKNOWN`/
  `KEY_EOF`. `Key` is `{ kind: string, char: string }`; `char` is only set
  when `kind == KEY_CHAR`.
- Kind constants: `KEY_CHAR`, `KEY_ENTER`, `KEY_BACKSPACE`, `KEY_TAB`,
  `KEY_ESCAPE`, `KEY_CTRL_C`, `KEY_CTRL_D`, `KEY_ARROW_UP`, `KEY_ARROW_DOWN`,
  `KEY_ARROW_LEFT`, `KEY_ARROW_RIGHT`, `KEY_EOF`, `KEY_UNKNOWN`.

Cursor and screen (plain ANSI strings, write them to stdout):

- `ENTER_ALT_SCREEN`, `EXIT_ALT_SCREEN` — switch to/from the alternate
  screen buffer, so the TUI doesn't scroll the user's normal terminal
  history.
- `HIDE_CURSOR`, `SHOW_CURSOR`.
- `CLEAR_SCREEN`, `CLEAR_LINE`.
- `cursorTo(row: int, col: int): string`, `cursorUp(n: int): string`,
  `cursorDown(n: int): string`, `cursorToColumn(col: int): string`.

## Build

```sh
cc -c tty_shim.c -o tty_shim.o
```

Then `// @link ./tty_shim.o` in any program that imports `tty.ts`.

## Scope

One fd's raw-mode state at a time. No mouse events, no function-key/Home/End/
PageUp decoding beyond the arrow keys, no wasm target (WASI has no terminal
ioctl surface). See `SPEC.md` for the full list.
