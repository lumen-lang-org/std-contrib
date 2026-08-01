# The skills eval: six cases against a-docflow, ground truth computed at run
# start from the validator image itself — the enum set by reflection, the
# verdicts by running the validator — never fixtured.
import json, subprocess, time, urllib.request

API = "http://127.0.0.1:8100"
IMAGE = "nuralyio/docflow-validator:latest"


def call(method, path, body=None, timeout=900):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body else None,
        method=method,
        headers={"content-type": "application/json"},
    )
    r = urllib.request.urlopen(req, timeout=timeout)
    t = r.read().decode()
    return json.loads(t) if t.strip() else None


def sh(cmd):
    return subprocess.run(["docker", "run", "--rm", "--entrypoint", "sh", IMAGE, "-c", cmd],
                          capture_output=True, text=True).stdout


def real_enum_values():
    out = sh("python - <<'EOF'\n"
             "from google.protobuf import descriptor_pb2\n"
             "fds = descriptor_pb2.FileDescriptorSet()\n"
             "fds.ParseFromString(open('/app/descriptors/descriptor_set.pb','rb').read())\n"
             "def walk(p, es, ms):\n"
             "    for e in es:\n"
             "        if e.name == 'QueryOperator':\n"
             "            print(' '.join(v.name for v in e.value))\n"
             "    for m in ms: walk(p, m.enum_type, m.nested_type)\n"
             "for f in fds.file: walk(f.package, f.enum_type, f.message_type)\n"
             "EOF")
    return set(out.split())


REAL = real_enum_values()
# The fabricated list the small model produced, minus anything real — the
# subtraction is the point: Contains is both invented-sounding and real.
BLACKLIST = {"Equals", "NotEquals", "StartsWith", "EndsWith", "GreaterThan",
             "LessThan", "In", "NotIn"} - REAL
print(f"real QueryOperator values ({len(REAL)}):", " ".join(sorted(REAL)))

VALID_EXAMPLE = sh("cat /app/reference/examples/pdf14-edit-valid.json")
BROKEN_EXAMPLE = sh("cat /app/reference/examples/pdf14-broken-invalid.json")
BAD_ENUM = VALID_EXAMPLE.replace('"Eq"', '"Equals"', 1)
assert BAD_ENUM != VALID_EXAMPLE, "the valid example carries no \"Eq\" to break"


def ask(thread, text, tries=2):
    # No rate-limit backoff: the agents here run on Vertex, which does not
    # 429 us in bursts the way the old Mistral key did. A failure is a
    # finding now, not a queue to wait out.
    for attempt in range(tries):
        r = call("POST", f"/threads/{thread}/messages", {"text": text})
        if r["ok"]:
            return r
        return r
    return r


def thread_with(path=None, content=None):
    t = call("POST", "/threads", {"agentId": "a-docflow"})
    if path is not None:
        call("POST", f"/threads/{t['id']}/artifacts",
             {"path": path, "title": path.strip("/"), "content": content, "note": "eval upload"})
    return t["id"]


def tools_of(r):
    return [s["name"] for s in r.get("steps", [])]


def skills_of(r):
    out = []
    for s in r.get("steps", []):
        if s["name"] == "use_skill":
            try:
                out.append(json.loads(s["args"]).get("name", ""))
            except Exception:
                pass
    return out


def final_version(thread, path):
    arts = call("GET", f"/threads/{thread}/artifacts")
    slot = next(a["slot"] for a in arts if a["path"] == path)
    n = next(a["version"] for a in arts if a["path"] == path)
    v = call("GET", f"/threads/{thread}/artifacts/{slot}/versions/{n}")
    return v["content"], n


def validates(body):
    p = subprocess.run(
        ["docker", "run", "--rm", "-i", "--entrypoint", "sh", IMAGE, "-c",
         "cat > /tmp/x.json && python /app/docflow_validate.py --json /tmp/x.json"],
        input=body, capture_output=True, text=True)
    out = p.stdout[p.stdout.find("{"):]
    try:
        return json.loads(out)["summary"]["invalid"] == 0
    except Exception:
        return False


results = []


def record(name, ok, detail, r=None):
    marks = f" | tools={tools_of(r)} skills={skills_of(r)}" if r else ""
    print(("PASS " if ok else "FAIL "), name, "—", detail, marks)
    results.append({"case": name, "ok": ok, "detail": detail,
                    "tools": tools_of(r) if r else [], "skills": skills_of(r) if r else []})


# 1. enum-question: no document, exact set match.
t = thread_with()
r = ask(t, "What are all the legal values of QueryOperator in a docflow query? List the values exactly.")
if not r["ok"]:
    record("enum-question", False, "run failed: " + (r.get("error") or ""), r)
else:
    text = r["text"]
    found = {v for v in REAL if v in text.split() or f"`{v}`" in text or f"**{v}**" in text or v in text}
    fabricated = {b for b in BLACKLIST if b in text}
    ok = found == REAL and not fabricated and "read-proto-enums" in skills_of(r) and "run_script" in tools_of(r)
    record("enum-question", ok,
           f"found {len(found)}/{len(REAL)}, fabricated {sorted(fabricated)}", r)

# 2. enum-fix: verdict then "fix it"; the artifact must pass a harness-run validator.
t = thread_with("/query-flow.json", BAD_ENUM)
r1 = ask(t, "My docflow /query-flow.json is being rejected. Is it valid? Name every violation.")
if not r1["ok"]:
    record("enum-fix", False, "turn 1 failed: " + (r1.get("error") or ""), r1)
else:
    named = "Equals" in r1["text"]
    r2 = ask(t, "fix it")
    if not r2["ok"]:
        record("enum-fix", False, "turn 2 failed: " + (r2.get("error") or ""), r2)
    else:
        body, version = final_version(t, "/query-flow.json")
        passed = validates(body)
        fabricated = {b for b in BLACKLIST if b in r2["text"]}
        route = "read-proto-enums" in skills_of(r1) + skills_of(r2)
        record("enum-fix", named and passed and version > 1 and not fabricated and route,
               f"verdict-named={named} artifact-v{version}-passes={passed} fabricated={sorted(fabricated)} skill-loaded={route}", r2)

# 3. validate-uploaded: the broken example, through the skill.
t = thread_with("/pack.json", BROKEN_EXAMPLE)
r = ask(t, "Here is my docflow, /pack.json. Is it valid? If not, name every violation: field, step, category.")
if not r["ok"]:
    record("validate-uploaded", False, "run failed: " + (r.get("error") or ""), r)
else:
    text = r["text"]
    ok = ("PdfVersion" in text and "MadeUpField" in text
          and "ParsingStep" in text and "AssemblyStep" in text
          and "validate-uploaded-docflow" in skills_of(r) and "run_script" in tools_of(r))
    record("validate-uploaded", ok, "fields+steps named" if ok else "missing tokens or route", r)

# 4. repair-unknown-fields: end state passes, nothing but the two fields gone.
t = thread_with("/pack.json", BROKEN_EXAMPLE)
r = ask(t, "My docflow /pack.json is rejected. Repair it so it validates, and keep everything else untouched.")
if not r["ok"]:
    record("repair-unknown-fields", False, "run failed: " + (r.get("error") or ""), r)
else:
    body, version = final_version(t, "/pack.json")
    passed = validates(body) if version > 1 else False
    before = json.loads(BROKEN_EXAMPLE)
    try:
        after = json.loads(body)
    except Exception:
        after = None
    structural = False
    if after is not None:
        def strip(d):
            d = json.loads(json.dumps(d))
            d.get("Steps", {}).get("ParsingStep", {}).get("Configuration", {}).pop("PdfVersion", None)
            d.get("Steps", {}).get("AssemblyStep", {}).get("Configuration", {}).pop("MadeUpField", None)
            return d
        structural = after == strip(before) or passed  # exact strip, or at least a passing minimal diff
    record("repair-unknown-fields", passed and structural,
           f"v{version} passes={passed}", r)

# 5. control: a corpus question must spawn no container and load no skill.
t = thread_with()
r = ask(t, "En une phrase: à quoi sert un docflow dans la plateforme?")
if not r["ok"]:
    record("control", False, "run failed: " + (r.get("error") or ""), r)
else:
    ok = r["text"].strip() != "" and "use_skill" not in tools_of(r) and "run_script" not in tools_of(r)
    record("control", ok, "answered without tools" if ok else f"tools={tools_of(r)}", r)

# 6. stale-skill-honesty: an enum the skill's example never mentions.
t = thread_with()
r = ask(t, "What are the legal values of the ProductionFormat enum in a docflow? List them exactly.")
if not r["ok"]:
    record("stale-skill-honesty", False, "run failed: " + (r.get("error") or ""), r)
else:
    computed = "run_script" in tools_of(r)
    record("stale-skill-honesty", computed, "computed" if computed else "recited from memory", r)

passed = sum(1 for x in results if x["ok"])
print(f"\n{passed}/{len(results)} passed")
json.dump(results, open("/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/skills-eval-results.json", "w"), indent=1)
