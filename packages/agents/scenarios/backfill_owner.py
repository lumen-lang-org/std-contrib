# Claim the pre-gateway rows for one owner tag. Run once, at cutover.
#
#     python3 scenarios/backfill_owner.py --owner 8f2c...-uuid          # dry run
#     python3 scenarios/backfill_owner.py --owner 8f2c...-uuid --write
#
# Migration 71 gives every thread that existed before there were owners
# `owner = ''`, and the guard is exact equality — never `'' OR tag` — so the
# moment AGENTS_TRUST_PROXY_AUTH goes on, that history belongs to nobody and
# is reachable by nobody. That is deliberate: the alternative reading hands the
# whole of the box's past to whoever authenticates first. Claiming it is this
# script, run knowingly, by a person who can name whose it was.
#
# The uuid is the `sub` of nuraly's JWT, which the gateway puts in X-USER as
# `uuid` and the engine stores verbatim. Get it from the users table, or from
# `select owner, count(*) from threads group by owner` after that account has
# opened one conversation through the gateway.
#
# Runs after the engine has migrated (the columns must exist) and, ideally,
# with the engine stopped: it is a write over rows a request could be reading.
import argparse, os, subprocess, sys

# The three tables that carry an owner. `runs` is joined back to its thread
# where it has one, so a conversation and its log lines do not end up claimed
# by different people; a run with no thread is a bare POST /agents/:id/run and
# is claimed on its own.
PLAN = [
    ("threads with no owner", """
        UPDATE threads SET owner = %(owner)s WHERE owner = ''
    """),
    ("runs belonging to a claimed thread", """
        UPDATE runs SET owner = t.owner
          FROM threads t
         WHERE runs.thread_id = t.id AND runs.owner = '' AND t.owner <> ''
    """),
    ("runs with no thread at all", """
        UPDATE runs SET owner = %(owner)s WHERE owner = '' AND thread_id = ''
    """),
]

COUNTS = """
    SELECT 'threads unowned', count(*) FROM threads WHERE owner = ''
    UNION ALL SELECT 'threads owned', count(*) FROM threads WHERE owner <> ''
    UNION ALL SELECT 'runs unowned', count(*) FROM runs WHERE owner = ''
    UNION ALL SELECT 'runs owned', count(*) FROM runs WHERE owner <> ''
"""


def psql(sql, args):
    """One statement, through psql, with the connection the engine uses."""
    env = dict(os.environ)
    env["PGPASSWORD"] = args.password
    out = subprocess.run(
        ["psql", "-h", args.host, "-U", args.user, "-d", args.database,
         "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql],
        capture_output=True, text=True, env=env,
    )
    if out.returncode != 0:
        sys.exit("psql: " + out.stderr.strip())
    return out.stdout.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--owner", required=True,
                   help="the tag to claim the unowned rows for — nuraly's user uuid")
    p.add_argument("--write", action="store_true",
                   help="actually write; without it nothing is changed")
    p.add_argument("--host", default=os.environ.get("AGENTS_PG_HOST", "127.0.0.1"))
    p.add_argument("--database", default=os.environ.get("AGENTS_PG_DATABASE", "agents"))
    p.add_argument("--user", default=os.environ.get("AGENTS_PG_USER", "agents"))
    p.add_argument("--password", default=os.environ.get("AGENTS_PG_PASSWORD", ""))
    args = p.parse_args()

    if "'" in args.owner or not args.owner.strip():
        sys.exit("an owner tag is a plain identifier; this one is not")

    print("before:")
    print(psql(COUNTS, args))

    if not args.write:
        print("\ndry run — nothing written. Add --write to claim them.")
        return

    # One transaction: a half-claimed database is a conversation whose runs
    # answer 404 to the person reading it.
    statements = ";\n".join(
        sql.strip().replace("%(owner)s", "'" + args.owner + "'") for _, sql in PLAN
    )
    psql("BEGIN;\n" + statements + ";\nCOMMIT;", args)

    print("\nafter:")
    print(psql(COUNTS, args))


if __name__ == "__main__":
    main()
