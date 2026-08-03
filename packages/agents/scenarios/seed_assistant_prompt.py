# Seed the assistant's system prompt.
#
# Committed for the same reason the skills are: a prompt that lives only in
# the database is a prompt nobody can review, and this one had a bug that a
# reader would have caught immediately.
#
# THE BUG, and the rule it teaches: the old body ended with
#
#     If asked, reply exactly: I cannot see my own engine — the model picker
#     beside the composer shows which model answers each message.
#
# and on prod the local 8B answered "does ecoflow accept more than 500w
# panel?" with that sentence. Then "test", with the same sentence. A scripted
# reply sitting in a prompt is a reply the model can reach for whenever it is
# unsure — the condition ("if asked") is one clause and the script is two
# lines, so the script is what gets remembered. Any exact output in a prompt
# needs its trigger stated at least as loudly as the words, and a small model
# needs to be told explicitly what NOT to use it for.
#
# A new version rather than an edit: prompts are versioned here (unlike
# skills, which are read fresh on every use), so an agent keeps pointing at
# the version it was configured with until somebody moves it.

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("AGENTS_API", "http://127.0.0.1:8100")
PROMPT_NAME = "assistant"


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


BODY = """You are Joule's assistant: helpful, direct and honest. Answer plainly and keep it short unless the question needs depth.

NEVER claim to have done something you did not do. If you say you searched, browsed, read a page or ran something, the tool call for it must be in this same turn. Writing "after browsing…" without the call is inventing evidence, and it is the worst answer you can give.

When a question has a current answer — a rate, a version, a price, what a page says — find it and state it. Search, then open the best results with the read-page skill and answer from their text, citing the url. A list of links is not an answer unless somebody asked where to look. If the pages do not settle it, say what you found and what is still unknown; never fill the gap from memory.

Answer the question you were actually asked. Every question about the world — a product, a spec, a price, a person, a place — is answered normally, with a search when it needs one.

There is exactly ONE question that has a fixed answer: somebody asking which model, engine or LLM is running you, or who made you. Only then, reply: I cannot see my own engine — the model picker beside the composer shows which model answers each message. Never guess or name a model.

That sentence is for that one question and nothing else. It is not an answer to a question you find hard, or vague, or short. If you are unsure what somebody means, ask them what they meant.

End every substantive answer with exactly one line in this shape, as the last line:

[FOLLOWUPS]{"items":["<a short follow-up question>","<another>","<a third>"]}[/FOLLOWUPS]

The items are the three questions THIS person would most plausibly ask next, written from what this conversation just covered — after a search they go deeper into what was found; after a document they extend or reshape it; after a conversion they ask about another amount, date or currency. Short, concrete, no numbering. The markers are the literal words FOLLOWUPS both times. Skip the line only when your whole message is you asking the person a question."""


def main():
    status, held = call("/prompts")
    if status != 200:
        raise SystemExit(f"cannot read prompts ({status})")
    rows = [p for p in json.loads(held) if p.get("promptName") == PROMPT_NAME]
    if not rows:
        raise SystemExit(f"no prompt named {PROMPT_NAME} on this deployment")
    latest = max(rows, key=lambda p: p.get("version", 0))
    row = {
        "id": "",
        "promptName": PROMPT_NAME,
        "version": latest.get("version", 0) + 1,
        "body": BODY,
        # Every member, or the record parse fails and the route answers
        # "promptName is required" about a body that plainly has one.
        "createdAt": "",
    }
    status, out = call("/prompts", "POST", row)
    print(f"assistant prompt v{row['version']} {status}", "" if status < 400 else out[:200])
    if status >= 400:
        return
    made = json.loads(out)
    # The agent has to be moved to it — a new version is inert until something
    # points at it, which is the whole reason prompts are versioned.
    status, agent = call("/agents/a-assistant")
    if status != 200:
        print("could not read a-assistant; point it at the new prompt by hand")
        return
    a = json.loads(agent)
    a["promptId"] = made["id"]
    for key in ("prompt", "config", "servers", "subAgents", "skills", "scopes"):
        a.pop(key, None)
    status, out = call("/agents/a-assistant", "PUT", a)
    print(f"a-assistant -> {made['id']} {status}", "" if status < 400 else out[:200])


if __name__ == "__main__":
    main()
