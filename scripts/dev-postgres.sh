#!/usr/bin/env bash
# Start the local Postgres cluster and create the dev/test role and databases. Idempotent.
#
# Local development values only (no real secrets): role `tmt`, password `tmt`,
# databases `tmt_dev` (DATABASE_URL) and `tmt_test` (TEST_DATABASE_URL; the test
# harness creates and drops per-file databases next to it, so the role has CREATEDB).
#
#   DATABASE_URL=postgres://tmt:tmt@localhost:5432/tmt_dev
#   TEST_DATABASE_URL=postgres://tmt:tmt@localhost:5432/tmt_test
#
# Debian/Ubuntu layout (postgresql-16 package) is assumed; set PG_VERSION / PG_CLUSTER /
# PG_PORT to override. Run as root, or as a user that can `sudo -u postgres`.
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
PG_CLUSTER="${PG_CLUSTER:-main}"
PG_PORT="${PG_PORT:-5432}"

as_postgres() {
	if [ "$(id -u)" = "0" ]; then
		su postgres -c "$*"
	elif [ "$(id -un)" = "postgres" ]; then
		bash -c "$*"
	else
		sudo -u postgres bash -c "$*"
	fi
}

if command -v pg_lsclusters >/dev/null 2>&1; then
	if ! pg_lsclusters --no-header | awk '{print $1" "$2" "$4}' | grep -q "^${PG_VERSION} ${PG_CLUSTER} online"; then
		echo "[dev-postgres] starting cluster ${PG_VERSION} ${PG_CLUSTER}"
		pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start 2>/dev/null || as_postgres "pg_ctlcluster $PG_VERSION $PG_CLUSTER start"
	fi
fi

for _ in $(seq 1 30); do
	as_postgres "psql -p $PG_PORT -tAc 'select 1'" >/dev/null 2>&1 && break
	sleep 1
done

psql_admin() { as_postgres "psql -p $PG_PORT -v ON_ERROR_STOP=1 -tAc \"$1\""; }

if [ "${1:-}" = "clean" ]; then
	# Drop databases a killed or crashed test run left behind (tmt_t_* clones, tmt_tpl_* templates).
	# Only run it while no test run is in progress.
	for db in $(psql_admin "select datname from pg_database where datname like 'tmt\\_t\\_%' or datname like 'tmt\\_tpl\\_%'"); do
		psql_admin "drop database \\\"$db\\\" with (force)" >/dev/null
		echo "[dev-postgres] dropped $db"
	done
	exit 0
fi

if [ "$(psql_admin "select 1 from pg_roles where rolname='tmt'")" != "1" ]; then
	psql_admin "create role tmt login createdb password 'tmt'"
	echo "[dev-postgres] created role tmt"
else
	psql_admin "alter role tmt login createdb password 'tmt'" >/dev/null
fi

for db in tmt_dev tmt_test; do
	if [ "$(psql_admin "select 1 from pg_database where datname='$db'")" != "1" ]; then
		psql_admin "create database $db owner tmt"
		echo "[dev-postgres] created database $db"
	fi
done

echo "[dev-postgres] ready: DATABASE_URL=postgres://tmt:tmt@localhost:${PG_PORT}/tmt_dev"
