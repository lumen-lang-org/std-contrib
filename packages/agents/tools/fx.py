#!/usr/bin/env python3
"""Today's rate, and a month of it, for the convert-currency card.

    python3 /skills/convert-currency/fx.py TND USD        # the rate
    python3 /skills/convert-currency/fx.py USD EUR 250    # and an amount

Prints one JSON line: rate, date, source, converted, and — when the source
answers for those days — history and historyLabels, which draw the chart.

A file the model RUNS rather than a script it retypes, and that is the whole
point. Asked to copy this script and change only its first line, a model
reliably shortens it: given an amount, one deleted the history loop outright
and the card lost its chart, on a run that otherwise looked perfect. Nothing
carried through a model's output survives contact with a model's judgement.

One source, chosen for coverage rather than pedigree: the ECB feed is better
data and lists about thirty currencies, but it 404s on TND — the currency
this deployment's own users ask about most — and the fallback that answered
it carried no history at all, so the chart could never draw for exactly the
people most likely to want it.
"""
from __future__ import annotations

import datetime
import json
import sys
import urllib.request

API = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{day}/v1/currencies/{code}.json"
# Every fourth day for four weeks: eight points, which is a readable line and
# eight requests. Daily would be four times the wait for a chart nobody would
# read differently.
STEP_DAYS = 4
SPAN_DAYS = 28


def get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "joule-fx/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=12))


def rates(day: str, code: str):
    return get(API.format(day=day, code=code))


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    src, dst = argv[1].lower(), argv[2].lower()
    amount = float(argv[3]) if len(argv) > 3 else 1.0

    now = rates("latest", src)
    if dst not in now.get(src, {}):
        raise SystemExit(f"no rate for {src.upper()}->{dst.upper()} — check the currency codes")
    out = {
        "rate": round(now[src][dst], 6),
        "date": now.get("date", ""),
        "source": "currency-api (daily)",
        "converted": round(now[src][dst] * amount, 6),
    }
    if amount != 1.0:
        out["amount"] = amount

    # A missing day is skipped, never fatal: the chart is the nice half of
    # this answer and the rate is the necessary half, so a source that is
    # down for one Tuesday must not cost the reader their conversion.
    history, labels = [], []
    today = datetime.date.today()
    for back in range(SPAN_DAYS, -1, -STEP_DAYS):
        day = (today - datetime.timedelta(days=back)).isoformat()
        try:
            r = rates(day, src)
            history.append(round(r[src][dst], 6))
            labels.append(day[5:])
        except Exception:
            continue
    if len(history) >= 2:
        out["history"] = history
        out["historyLabels"] = labels

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
