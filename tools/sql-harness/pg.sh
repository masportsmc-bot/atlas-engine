#!/bin/bash
# Local, throwaway PostgreSQL 16 cluster for offline SQL tests (unix socket only, no TCP).
set -e
H0=$(cd "$(dirname "$0")" && pwd); H=${MI08_PG_DIR:-/tmp/mi08-int006-pg}; mkdir -p $H; BIN=/usr/lib/postgresql/16/bin; D=$H/pgdata; SOCK=$H/sock
case "$1" in
  start) rm -rf "$D" "$SOCK"; mkdir -p "$SOCK"; chmod 700 "$SOCK"
         if [ "$(id -u)" = 0 ]; then chown -R nobody "$H"; fi
         RUN() { if [ "$(id -u)" = 0 ]; then su -s /bin/bash nobody -c "$*"; else bash -c "$*"; fi; }
         RUN "$BIN/initdb -D $D -U postgres -A trust --no-locale -E UTF8 >/dev/null"
         RUN "$BIN/pg_ctl -D $D -o \"-c listen_addresses='' -c unix_socket_directories=$SOCK -c fsync=off\" -l $H/pg.log -w start >/dev/null" ;;
  stop)  RUN() { if [ "$(id -u)" = 0 ]; then su -s /bin/bash nobody -c "$*"; else bash -c "$*"; fi; }
         RUN "$BIN/pg_ctl -D $D -m immediate stop >/dev/null" || true ;;
esac
