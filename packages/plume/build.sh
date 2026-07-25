#!/bin/sh
# Build the C shims the drivers link against. Each is optional: a program that
# uses one driver never links the other, so a missing library is a skipped
# shim, not a failed build.
#   Debian, Ubuntu   apt install libpq-dev libsqlite3-dev libmariadb-dev
#   macOS            brew install postgresql@17 sqlite mariadb
set -e
cd "$(dirname "$0")"
if command -v pg_config >/dev/null 2>&1; then
  INCLUDE="$(pg_config --includedir)"
else
  INCLUDE="/usr/include/postgresql"
  [ -d "$INCLUDE" ] || INCLUDE="/opt/homebrew/include/postgresql@17"
fi
if [ -f "$INCLUDE/libpq-fe.h" ]; then
  cc -c plume_shim.c -I"$INCLUDE" -o plume_shim.o
  echo "postgres: built plume_shim.o against $INCLUDE"
else
  echo "postgres: skipped — libpq headers not found (apt install libpq-dev)"
fi

if [ -f /usr/include/sqlite3.h ] || [ -f /opt/homebrew/include/sqlite3.h ]; then
  cc -c sqlite_shim.c -o sqlite_shim.o
  echo "sqlite: built sqlite_shim.o"
else
  echo "sqlite: skipped — sqlite3.h not found (apt install libsqlite3-dev)"
fi

MYSQL_INCLUDE=""
if command -v mariadb_config >/dev/null 2>&1; then
  # mariadb_config prints several -I flags; the first holds mysql.h.
  MYSQL_INCLUDE="$(mariadb_config --include | tr ' ' '\n' | sed -n 's/^-I//p' | head -1)"
elif command -v mysql_config >/dev/null 2>&1; then
  MYSQL_INCLUDE="$(mysql_config --include | tr ' ' '\n' | sed -n 's/^-I//p' | head -1)"
elif [ -d /usr/include/mariadb ]; then
  MYSQL_INCLUDE="/usr/include/mariadb"
fi
if [ -n "$MYSQL_INCLUDE" ] && [ -f "$MYSQL_INCLUDE/mysql.h" ]; then
  cc -c mysql_shim.c -I"$MYSQL_INCLUDE" -o mysql_shim.o
  echo "mysql: built mysql_shim.o against $MYSQL_INCLUDE"
else
  echo "mysql: skipped — mysql.h not found (apt install libmariadb-dev)"
fi
