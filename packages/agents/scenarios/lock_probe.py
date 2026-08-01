# The post-deploy probe for the bearer lock: does :8100 actually want the
# token it was configured with, and does the probe route still answer without
# one?
#
#     python3 scenarios/lock_probe.py                    # reads .env
#     python3 scenarios/lock_probe.py --token s3cret
#     python3 scenarios/lock_probe.py --api http://127.0.0.1:8100
#
# Runnable in both states on purpose. With no AGENTS_API_TOKEN it asserts the
# opposite — every route answers without one — so "the lock is off" is a
# printed fact rather than a probe that quietly passed because it checked
# nothing. That is the failure mode worth guarding: the top risk in GATEWAY.md
# is :8100 reachable with the trust gate on, and a lock nobody noticed was
# empty is exactly how that happens.
import argparse
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(os.path.dirname(HERE), ".env")


def configured_token():
    """AGENTS_API_TOKEN as the unit will see it: the environment first, then
    the .env file the unit sources."""
    said = os.environ.get("AGENTS_API_TOKEN")
    if said is not None:
        return said.strip()
    if not os.path.exists(ENV):
        return ""
    for line in open(ENV):
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == "AGENTS_API_TOKEN":
            return value.strip()
    return ""


def status(api, path, token):
    req = urllib.request.Request(api + path, method="GET")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        return urllib.request.urlopen(req, timeout=10).status
    except urllib.error.HTTPError as e:
        return e.code
    except OSError as e:
        print(f"  !! {path}: {e}")
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8100")
    ap.add_argument("--token", default=None)
    args = ap.parse_args()

    token = args.token if args.token is not None else configured_token()
    bad = []

    def want(label, got, expected):
        ok = got == expected
        print(f"  {'ok ' if ok else 'FAIL'} {label}: {got} (wanted {expected})")
        if not ok:
            bad.append(label)

    # Always: the probe answers, with or without a token. A gateway that
    # cannot reach this cannot tell down from misconfigured.
    print("healthz")
    want("GET /healthz, no credential", status(args.api, "/healthz", ""), 200)

    if not token:
        print("no AGENTS_API_TOKEN configured — the lock is OFF")
        print("routes")
        want("GET /agents, no credential", status(args.api, "/agents", ""), 200)
        print("The firewall is then the only thing between :8100 and whoever "
              "finds it. Fine while the trust gate is off; not fine with it on.")
    else:
        print(f"AGENTS_API_TOKEN configured ({len(token)} chars) — the lock is ON")
        print("routes")
        want("GET /agents, no credential", status(args.api, "/agents", ""), 401)
        want("GET /agents, wrong token", status(args.api, "/agents", token + "x"), 401)
        want("GET /agents, the token", status(args.api, "/agents", token), 200)
        # A path that does not exist is 401 too, so an unauthorised caller
        # cannot map the API by watching which paths answer differently.
        want("GET /nothing-here, no credential", status(args.api, "/nothing-here", ""), 401)

    if bad:
        print(f"\n{len(bad)} probe(s) failed: {', '.join(bad)}")
        sys.exit(1)
    print("\nall probes passed")


if __name__ == "__main__":
    main()
