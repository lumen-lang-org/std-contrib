#!/bin/sh
# Build the object files cron.ts links against.
#
# No system dependency: ccronexpr is vendored beside this script, so a machine
# with a C compiler and a zone database (/usr/share/zoneinfo — every Linux, and
# the `tzdata` package in a slim container) can build it.
#
#   ./build.sh
#
# -DCRON_USE_LOCAL_TIME is load-bearing: without it ccronexpr computes in UTC
# and the zone the shim installs is ignored, so every task fires at the right
# UTC time and the wrong local one. That is a silent wrong answer, which is why
# it is set here rather than left to the caller.
set -e
cd "$(dirname "$0")"

CFLAGS="-c -std=gnu99 -D_GNU_SOURCE -DCRON_USE_LOCAL_TIME -O2 -fPIC"

cc $CFLAGS ccronexpr.c -o ccronexpr.o
cc $CFLAGS cron_shim.c -o cron_shim.o
echo "built ccronexpr.o and cron_shim.o"
