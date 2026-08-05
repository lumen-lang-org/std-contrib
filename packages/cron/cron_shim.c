// A scalar/string-friendly C surface over ccronexpr, with the timezone bolted
// on.
//
// ccronexpr answers in `time_t` and reads the ambient zone through libc, which
// makes it awkward in exactly the way a scheduler cares about: the zone is
// process state, and a scheduler holds one zone per task. So every function
// here takes the zone as an argument, installs it for the length of the call,
// and puts back whatever was there before.
//
// Milliseconds, not seconds, at the boundary: `Date.now()` is milliseconds
// everywhere in Lumen, and a boundary that changes units is a boundary that
// eventually gets one call wrong.
//
// NOT THREAD-SAFE, and it cannot be made so with libc alone: `TZ` is process
// state and `tzset()` rewrites the global zone. The intended caller is a
// single-threaded process that computes a schedule and exits. If this ever
// needs to run beside other threads, the fix is not a mutex — it is vendoring
// IANA tzcode for `tzalloc`/`mktime_z`, which take the zone as a handle.
//
// Build:
//   cc -c -std=gnu99 -D_GNU_SOURCE -DCRON_USE_LOCAL_TIME cron_shim.c -o cron_shim.o
//   cc -c -std=gnu99 -D_GNU_SOURCE -DCRON_USE_LOCAL_TIME ccronexpr.c -o ccronexpr.o

#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <time.h>

#include "ccronexpr.h"

// Owns the most recent string result so the pointer handed back stays valid
// until the next call, the way the SQLite and Poppler shims do.
static char g_text[256];

// The previous TZ, saved across a call. `getenv` returns a pointer into the
// environment that `setenv` is free to invalidate, so it is copied.
struct zone_save {
    char had;
    char was[128];
};

static void zone_enter(const char *zone, struct zone_save *saved) {
    const char *old = getenv("TZ");
    saved->had = old ? 1 : 0;
    saved->was[0] = '\0';
    if (old) {
        strncpy(saved->was, old, sizeof(saved->was) - 1);
        saved->was[sizeof(saved->was) - 1] = '\0';
    }
    // An empty zone means "leave the ambient one alone" — which is UTC on a
    // server and whatever the operator set on a laptop. Naming it explicitly
    // is better, and the Lumen side defaults to "UTC" so this is rare.
    if (zone && zone[0]) {
        setenv("TZ", zone, 1);
        tzset();
    }
}

static void zone_leave(const char *zone, struct zone_save *saved) {
    if (!(zone && zone[0])) return;
    if (saved->had) setenv("TZ", saved->was, 1);
    else unsetenv("TZ");
    tzset();
}

// "" if the expression parses, otherwise ccronexpr's own complaint — which
// names the field, so it is worth passing through to whoever typed it.
const char *cron_error(const char *expr) {
    cron_expr parsed;
    const char *err = NULL;
    memset(&parsed, 0, sizeof(parsed));
    g_text[0] = '\0';
    if (!expr || !expr[0]) {
        strncpy(g_text, "an empty expression is not a schedule", sizeof(g_text) - 1);
        return g_text;
    }
    cron_parse_expr(expr, &parsed, &err);
    if (err) {
        strncpy(g_text, err, sizeof(g_text) - 1);
        g_text[sizeof(g_text) - 1] = '\0';
    }
    return g_text;
}

// The first firing strictly after `after_ms`, in the given zone, as epoch
// milliseconds. -1 when the expression does not parse or has no next time
// (a Feb 30 will do that), which the caller must check — a schedule that
// silently became 1970 fires every pass, forever.
long long cron_next_ms(const char *zone, const char *expr, long long after_ms) {
    cron_expr parsed;
    const char *err = NULL;
    struct zone_save saved;
    time_t got;

    memset(&parsed, 0, sizeof(parsed));
    cron_parse_expr(expr ? expr : "", &parsed, &err);
    if (err) return -1;

    zone_enter(zone, &saved);
    got = cron_next(&parsed, (time_t) (after_ms / 1000));
    zone_leave(zone, &saved);

    if (got == (time_t) -1) return -1;
    return ((long long) got) * 1000;
}

// The most recent firing at or before `before_ms`. Used to answer "when should
// this have last run", which is how a restart decides whether it missed one.
long long cron_prev_ms(const char *zone, const char *expr, long long before_ms) {
    cron_expr parsed;
    const char *err = NULL;
    struct zone_save saved;
    time_t got;

    memset(&parsed, 0, sizeof(parsed));
    cron_parse_expr(expr ? expr : "", &parsed, &err);
    if (err) return -1;

    zone_enter(zone, &saved);
    got = cron_prev(&parsed, (time_t) (before_ms / 1000));
    zone_leave(zone, &saved);

    if (got == (time_t) -1) return -1;
    return ((long long) got) * 1000;
}

// An instant as civil time in the zone: "2026-03-30 08:00:00 CEST". For
// showing a person when their task next runs, and for tests, which is the
// harder requirement — an assertion written in epoch milliseconds tells a
// reader nothing about what broke.
const char *cron_format_ms(const char *zone, long long at_ms) {
    struct zone_save saved;
    time_t t = (time_t) (at_ms / 1000);
    struct tm broken;

    g_text[0] = '\0';
    zone_enter(zone, &saved);
    if (localtime_r(&t, &broken)) {
        strftime(g_text, sizeof(g_text), "%Y-%m-%d %H:%M:%S %Z", &broken);
    }
    zone_leave(zone, &saved);
    return g_text;
}

// The zone's offset from UTC at that instant, in minutes — +120 for Paris in
// summer. The console needs this to print "08:00 (UTC+2)" without shipping a
// zone database to the browser.
int cron_offset_minutes(const char *zone, long long at_ms) {
    struct zone_save saved;
    time_t t = (time_t) (at_ms / 1000);
    struct tm broken;
    int minutes = 0;

    zone_enter(zone, &saved);
    if (localtime_r(&t, &broken)) minutes = (int) (broken.tm_gmtoff / 60);
    zone_leave(zone, &saved);
    return minutes;
}

// Whether the zone is one this machine knows.
//
// This asks the filesystem rather than libc, and the first attempt at it is
// worth recording because it looked right and was not: an unknown `TZ` does
// not make libc fail. glibc falls back to reading the name as a POSIX rule
// ("EST5EDT"), so "Mars/Olympus" parses as a zone called "Mars" at UTC+0 and
// every arithmetic function answers cheerfully. Comparing offsets in January
// and July to spot the fallback passes that garbage too.
//
// So: the zone database is files, and a zone this machine knows is a file this
// machine has. `..` and an absolute path are refused because the name reaches
// this from a form.
int cron_zone_known(const char *zone) {
    char path[512];
    const char *dir;

    if (!zone || !zone[0]) return 0;
    if (zone[0] == '/' || strstr(zone, "..")) return 0;
    if (strcmp(zone, "UTC") == 0) return 1;

    dir = getenv("TZDIR");
    if (!dir || !dir[0]) dir = "/usr/share/zoneinfo";
    if (strlen(dir) + strlen(zone) + 2 > sizeof(path)) return 0;
    strcpy(path, dir);
    strcat(path, "/");
    strcat(path, zone);
    return access(path, R_OK) == 0 ? 1 : 0;
}
