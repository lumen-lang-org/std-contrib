# Seed the convert-currency skill.
#
# Committed for the reason fill-doc was not, and cost a day for it: a briefing
# that lives only in the database is a briefing nobody can review. Run it to
# update the skill; run it twice to prove it is idempotent.
#
# Two things this briefing does NOT ask the model to do, both learned by
# measurement:
#
#   copy the history      it was asked to copy `history` and `historyLabels`
#                         into the card block and did it on 0 of 6 runs across
#                         six currency pairs. Fourteen numbers through prose is
#                         not a job for a model. The console reads them out of
#                         this script's own stdout instead (cards.ts,
#                         CardEvidence), so the block stays small and the chart
#                         draws from the tool's output.
#
#   see realistic output  a body carrying a filled-in example got parroted
#                         instead of run — twice — and the model invented a
#                         30-point history rather than fetching one.

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
SKILL_ID = "k-convert-currency"


def call(path, method="GET", body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# One source, and it is chosen for COVERAGE rather than pedigree. The ECB
# feed is the better data and lists about thirty currencies; it 404s on TND,
# which is the currency this deployment's own users ask about most, and the
# fallback that answered it carried no history at all — so the chart could
# never draw for exactly the people most likely to want it. A daily feed
# covering ~200 currencies gets everyone a rate and a history; the source is
# named in the card so a reader can weigh it.
BODY = """ALWAYS run the tool first. You do not know today's rate, and the numbers in this text are not rates — they are placeholders.
No amount in the question means amount 1: answer with the rate. Never ask the reader for an amount.

1. run_script, environment "main", language "sh", paths []. One line, with the two currency codes and — only if the reader gave one — an amount:

python3 /skills/convert-currency/fx.py TND USD

Nothing else. Do not write your own script, do not paste this one into python, do not edit the tool. It prints one JSON line with the rate, the date, the source, and the month of history that draws the chart.

2. EVERY answer ends with one short sentence and then one line in this exact shape:

[CURRENCY]{"from":FROM,"to":TO,"rate":RATE,"asOf":DATE,"source":SOURCE}[/CURRENCY]

The opening marker is the literal text [CURRENCY] and the closing one [/CURRENCY] — the same seven letters every time, whatever the currencies are. Never put a currency code in the marker.

FROM, TO, RATE, DATE and SOURCE are filled from the tool's output. Add "converted" (and "amount") when the reader gave an amount.

Do NOT copy the history into the block. The rate chart is drawn from the tool's own output, so the block stays short — five members, nothing else.

An answer with no run_script call in this same turn is wrong, however sure you feel: without it you have no rate to report."""


def main():
    status, held = call("/skills/" + SKILL_ID)
    if status != 200:
        raise SystemExit(f"{SKILL_ID} is not on this deployment ({status}) — seed it by hand first")
    row = json.loads(held)
    row["body"] = BODY
    status, out = call("/skills/" + SKILL_ID, "PUT", row)
    print(f"convert-currency skill {status}", "" if status < 400 else out[:200])

    # The tool itself, staged at /skills/convert-currency/fx.py. Attached or
    # public skills are staged into every run (run-script.ts), so the command
    # in the briefing is there before the model asks for it.
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    body = open(os.path.join(here, "tools", "fx.py")).read()
    fid = SKILL_ID + ":fx.py"
    frow = {"id": fid, "skillId": SKILL_ID, "path": "fx.py", "body": body}
    status, out = call(f"/skills/{SKILL_ID}/files/{fid}", "PUT", frow)
    if status == 404:
        status, out = call(f"/skills/{SKILL_ID}/files", "POST", frow)
    print(f"convert-currency fx.py {status}", "" if status < 400 else out[:200])


if __name__ == "__main__":
    main()
