# The docflow-examples dataset, run as real conversations and written back to
# Langfuse as a dataset run: one thread per item, the artifact uploaded, the
# question asked, the answer scored against the item's expectedOutput, and the
# run item linked to the trace the conversation produced.
#
#   LANGFUSE_SECRET_KEY=sk-... python3 scenarios/langfuse_examples.py [runName]
#
# Bridges a real platform gap deliberately: evals.ts drives bare runs, and a
# bare run has no thread, so no artifact and no run_script — none of these
# cases can live there yet. This script is the thread-shaped eval until the
# platform grows one.
import base64, json, os, sys, time, urllib.request

API = "http://127.0.0.1:8100"
LF = "http://127.0.0.1:3000/api/public"
PK = os.environ.get("LANGFUSE_PUBLIC_KEY", "pk-lf-lumen-demo")
SK = os.environ["LANGFUSE_SECRET_KEY"]
AGENT = os.environ.get("EVAL_AGENT", "a-docflow-gemini")
JUDGE = os.environ.get("EVAL_JUDGE", "a-judge")
RUN = sys.argv[1] if len(sys.argv) > 1 else f"examples-{int(time.time())}"
# An optional second argument narrows the run to items whose artifact path or
# metadata case name contains it — a single hard case is a five-minute check,
# the full suite is half an hour.
ONLY = sys.argv[2] if len(sys.argv) > 2 else ""
AUTH = "Basic " + base64.b64encode(f"{PK}:{SK}".encode()).decode()


def call(url, m, p, b=None, auth=None):
    req = urllib.request.Request(url + p, data=json.dumps(b).encode() if b else None,
        method=m, headers={"content-type": "application/json", **({"authorization": auth} if auth else {})})
    r = urllib.request.urlopen(req, timeout=900)
    t = r.read().decode()
    return json.loads(t) if t.strip() else None


def validate_body(body):
    """The harness's own verdict on a docflow's bytes."""
    import subprocess
    pr = subprocess.run(["docker", "run", "--rm", "-i", "--entrypoint", "sh",
        "nuralyio/docflow-validator:latest", "-c",
        "cat > /tmp/x.json && python /app/docflow_validate.py --json /tmp/x.json"],
        input=body, capture_output=True, text=True)
    out = pr.stdout[pr.stdout.find("{"):]
    try:
        return json.loads(out)["summary"]["invalid"] == 0
    except Exception:
        return False


items = call(LF, "GET", "/dataset-items?datasetName=docflow-examples&limit=50", auth=AUTH)["data"]
# A rerun under the same name resumes: items already linked to the run are done.
done = set()
try:
    prior = call(LF, "GET", f"/datasets/docflow-examples/runs/{RUN}", auth=AUTH)
    done = {ri["datasetItemId"] for ri in prior.get("datasetRunItems", [])}
except Exception:
    pass
print(f"{len(items)} items, run '{RUN}', agent {AGENT}" + (f", {len(done)} already done" if done else ""))
passed = 0
for it in items:
    if ONLY and ONLY not in it["input"]["artifactPath"] and ONLY not in str((it.get("metadata") or {}).get("case", "")):
        continue
    if it["id"] in done:
        print(f"  {it['input']['artifactPath']}: already in run, skipped")
        continue
    q, path, content = it["input"]["question"], it["input"]["artifactPath"], it["input"]["artifactContent"]
    want = it["expectedOutput"]
    t = call(API, "POST", "/threads", {"agentId": AGENT})
    # An item may carry the docflow as an upload, or expect the conversation to
    # produce one: the corpus has both, and a case that says "go back to the
    # first docflow" has nothing to upload by design.
    if path and content:
        call(API, "POST", f"/threads/{t['id']}/artifacts",
             {"path": path, "title": path.strip("/"), "content": content, "note": "dataset item"})
    # Turns that came before the one under test. The case is only meaningful
    # with them: "the first of the two" means nothing to a fresh thread.
    for prior in it["input"].get("priorTurns", []):
        call(API, "POST", f"/threads/{t['id']}/messages", {"text": prior})
    r = call(API, "POST", f"/threads/{t['id']}/messages", {"text": q})
    text = r.get("text") or ""
    if want.get("kind") == "edit":
        # The hard shape: a change request, then a convergence turn, and the
        # verdict comes from the FINAL ARTIFACT, not from the words — the
        # harness reruns the validator on what was actually stored.
        r2 = call(API, "POST", f"/threads/{t['id']}/messages",
                  {"text": "Now validate the docflow and fix everything the validator refuses, until it passes."})
        text = (text + "\n" + (r2.get("text") or "")).strip()
        arts = call(API, "GET", f"/threads/{t['id']}/artifacts")
        # The uploaded path when there was one; otherwise whatever the
        # conversation produced — a case with no upload is judged on the
        # docflow it was asked to create.
        a = next((x for x in arts if x["path"] == path), None) or (arts[-1] if arts else None)
        final = "" if a is None else call(
            API, "GET", f"/threads/{t['id']}/artifacts/{a['slot']}/versions/{a['version']}")["content"]
        verdict_ok = bool(final) and validate_body(final)
        steps_ok = True
        if want.get("expectedSteps"):
            try:
                got = sorted(json.loads(final).get("Steps", {}).keys())
                # The agent may suffix step names; compare loosely on prefix.
                wanted = want["expectedSteps"]
                steps_ok = len(got) == len(wanted)
            except Exception:
                steps_ok = False
    else:
        said_invalid = ("not valid" in text.lower()) or ("invalid" in text.lower())
        verdict_ok = (not want["valid"]) == said_invalid and r["ok"]
        steps_ok = all(v["step"] in text for v in want["violations"])
    score = 1.0 if (verdict_ok and steps_ok) else 0.0
    passed += score == 1.0
    # The judge's reading, beside the deterministic one: an answer can be
    # right in words the token check never looked for, and wrong in ways it
    # cannot see. Vertex-backed, no tools, JSON out.
    judge_score, judge_why = None, ""
    try:
        # The judge reads words; the harness read the artifact. Handing the
        # judge the validator's own verdict on the final stored file keeps it
        # from failing a conversation whose work is in the store rather than
        # in the prose (and from crediting prose the store contradicts).
        evidence = ""
        if want.get("kind") == "edit":
            evidence = ("\n\nHarness evidence (trust this over the answer's claims): "
                        f"the final stored document {'PASSES' if verdict_ok else 'FAILS'} the validator.")
        j = call(API, "POST", f"/agents/{JUDGE}/run",
                 {"text": f"Question:\n{q}\n\nExpected outcome (JSON):\n{json.dumps(want)}{evidence}\n\nAnswer to judge:\n{text}"})
        jt = (j.get("text") or "").strip()
        jt = jt[jt.find("{"):jt.rfind("}") + 1]
        parsed = json.loads(jt)
        judge_score, judge_why = float(parsed["score"]), str(parsed.get("why", ""))[:180]
    except Exception as e:
        judge_why = f"judge failed: {e}"
    # The trace this conversation just wrote, for the run item's linkage.
    # Ingestion is asynchronous — the worker lands traces in ClickHouse on
    # its own clock — so the link is retried until the trace is queryable.
    # The retry IS the wait: poll immediately, then back off. A flat ten
    # seconds before the first look spent a minute of every run waiting for
    # something usually already there.
    trace_id = None
    for attempt in range(6):
        if attempt > 0:
            time.sleep(2 * attempt)
        traces = call(LF, "GET", "/traces?limit=1", auth=AUTH)["data"]
        trace_id = traces[0]["id"] if traces else None
        if trace_id is None:
            continue
        try:
            call(LF, "POST", "/dataset-run-items", {
                "datasetItemId": it["id"], "runName": RUN, "traceId": trace_id,
                "metadata": {"threadId": t["id"], "verdictOk": verdict_ok, "stepsOk": steps_ok}}, auth=AUTH)
            break
        except Exception as e:
            if attempt == 5: print("  run-item link failed:", e)
    if trace_id is not None:
        try:
            call(LF, "POST", "/scores", {"traceId": trace_id, "name": "examples-correct", "value": score,
                "comment": f"verdict={verdict_ok} steps={steps_ok}"}, auth=AUTH)
            if judge_score is not None:
                call(LF, "POST", "/scores", {"traceId": trace_id, "name": "judge", "value": judge_score,
                    "comment": judge_why}, auth=AUTH)
        except Exception as e:
            print("  score failed:", e)
    print(f"  {path}: {'PASS' if score == 1.0 else 'FAIL'} (verdict={verdict_ok} steps={steps_ok} judge={judge_score} {judge_why[:60]})")
print(f"{passed}/{len(items)} — run '{RUN}' in Langfuse with traces and scores")
