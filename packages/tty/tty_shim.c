// A scalar-only C shim over POSIX termios.
//
// termios controls a terminal's line discipline through a struct (c_iflag,
// c_oflag, c_cflag, c_lflag, cc_t c_cc[NCCS], ...). The Lumen FFI marshals
// only scalars and strings (specs 009, 023), not structs, so this shim keeps
// the struct on the C side and exposes plain int-in/int-out functions: enable
// raw mode, disable it, read one byte, ask whether an fd is a terminal at all.
//
// Build:
//   cc -c tty_shim.c -o tty_shim.o

#include <termios.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <poll.h>

// The settings saved by the most recent raw_enable, restored by raw_disable.
// One fd at a time, matching the single-connection style other shims in this
// repo use (see packages/sqlite/sqlite_shim.c) until a package here needs more.
static struct termios g_saved;
static int g_have_saved = 0;

// Is `fd` connected to a terminal? Returns 1 or 0.
int tty_isatty(int fd) {
    return isatty(fd) ? 1 : 0;
}

// Switch `fd` into raw mode: no line buffering, no echo, bytes delivered as
// typed. Saves the prior settings so raw_disable can restore them. Returns 0
// on success, -1 if `fd` is not a terminal or the settings could not be read
// or applied.
int tty_raw_enable(int fd) {
    struct termios raw;
    if (tcgetattr(fd, &g_saved) != 0) {
        return -1;
    }
    raw = g_saved;
    cfmakeraw(&raw);
    if (tcsetattr(fd, TCSANOW, &raw) != 0) {
        return -1;
    }
    g_have_saved = 1;
    return 0;
}

// Restore the settings saved by the last successful raw_enable. Returns 0 on
// success, -1 if there is nothing saved or the settings could not be applied.
int tty_raw_disable(int fd) {
    if (!g_have_saved) {
        return -1;
    }
    if (tcsetattr(fd, TCSANOW, &g_saved) != 0) {
        return -1;
    }
    g_have_saved = 0;
    return 0;
}

// Block for exactly one byte from `fd`. Returns the byte (0-255), -1 at EOF,
// -2 on a read error.
int tty_read_byte(int fd) {
    unsigned char c;
    ssize_t n = read(fd, &c, 1);
    if (n == 0) {
        return -1;
    }
    if (n < 0) {
        return -2;
    }
    return (int)c;
}

// Block for up to `timeout_ms` for a byte to become available on `fd`, then
// read exactly one. Used to tell a lone Escape keypress (nothing follows)
// from the start of an escape sequence (more bytes arrive immediately) -
// tty_read_byte alone cannot distinguish the two, since it blocks forever.
// Returns the byte (0-255), -1 at EOF, -2 on a read/poll error, -3 if the
// timeout elapsed with nothing available.
int tty_read_byte_timeout(int fd, int timeout_ms) {
    struct pollfd p;
    p.fd = fd;
    p.events = POLLIN;
    p.revents = 0;
    int r = poll(&p, 1, timeout_ms);
    if (r == 0) {
        return -3;
    }
    if (r < 0) {
        return -2;
    }
    return tty_read_byte(fd);
}

// The terminal's current width and height. Ref<T> is disallowed on FFI
// parameters (spec 024), so this is two scalar-returning calls rather than
// one call with two out-params. Each re-reads via ioctl, cheap and always
// current, no caching. Returns -1 if `fd` is not a terminal.
int tty_cols(int fd) {
    struct winsize ws;
    if (ioctl(fd, TIOCGWINSZ, &ws) != 0) {
        return -1;
    }
    return (int)ws.ws_col;
}

int tty_rows(int fd) {
    struct winsize ws;
    if (ioctl(fd, TIOCGWINSZ, &ws) != 0) {
        return -1;
    }
    return (int)ws.ws_row;
}

// Open /dev/null and return its fd. Test-only: gives the test suite a real,
// always-non-terminal fd to exercise isatty/raw_enable/read_byte against,
// without depending on whatever fd 0/1/2 happen to be under the test runner.
int tty_open_devnull_for_test(void) {
    return open("/dev/null", O_RDONLY);
}

// Test-only pipe: the read end is returned for readByte/readKey to consume,
// the write end is kept here so tests can push exact byte sequences (arrow
// keys, a lone Escape with nothing following) without a live terminal.
static int g_test_pipe_write_fd = -1;

int tty_open_test_pipe(void) {
    int fds[2];
    if (pipe(fds) != 0) {
        return -1;
    }
    g_test_pipe_write_fd = fds[1];
    return fds[0];
}

int tty_write_byte_to_test_pipe(int byte) {
    if (g_test_pipe_write_fd < 0) {
        return -1;
    }
    unsigned char c = (unsigned char)byte;
    if (write(g_test_pipe_write_fd, &c, 1) != 1) {
        return -1;
    }
    return 1;
}
