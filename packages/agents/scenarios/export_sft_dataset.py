# Export the engine's real conversations as a fine-tuning dataset.
#
# The runs table already holds exactly what supervised tool-use training
# wants: a person's actual question, the tool calls the model made, what the
# tools really answered, and the reply that satisfied the person — with `ok`
# saying whether the round completed. This script turns each successful run
# into one JSONL sample in the OpenAI messages shape (assistant tool_calls +
# role:"tool" results), which every SFT pipeline — LLaMA-Factory, axolotl,
# unsloth — renders into Qwen's own chat template without help.
#
#     python3 scenarios/export_sft_dataset.py                        # all ok runs with steps
#     python3 scenarios/export_sft_dataset.py --skill make-doc       # runs that used one skill
#     python3 scenarios/export_sft_dataset.py --out my.jsonl --max-result 2000
#
# Reads postgres through the db container rather than the API: the API scopes
# every read to one owner, which is right for people and wrong for a corpus.
# Read-only — this script never writes a row.
#
# What is deliberately NOT here:
#   * failed runs. A trajectory that ends in an apology teaches apologising.
#     (Failed TOOL CALLS inside a successful run stay: recovering from a
#     refused call is exactly the behaviour worth learning.)
#   * the system prompt. It changes per agent and per version; a pipeline
#     that wants it can join runs.prompt_version to the prompts table. The
#     samples train the tool-use shape, not the persona.
#   * anonymisation. These are this deployment's own conversations for this
#     deployment's own model. Do not ship the file anywhere else as-is.

import argparse
import json
import subprocess
import sys

DB = ["docker", "exec", "agents-db-1", "psql", "-U", "agents", "-d", "agents", "-tA", "-c"]


def rows(sql):
    out = subprocess.run(DB + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit("psql: " + out.stderr.strip()[:300])
    text = out.stdout.strip()
    return json.loads(text) if text else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skill", default="", help="keep only runs whose steps used this skill or tool")
    ap.add_argument("--out", default="dataset-sft.jsonl")
    ap.add_argument("--max-result", type=int, default=4000,
                    help="truncate a tool result to this many chars (0 = keep whole)")
    ap.add_argument("--min-steps", type=int, default=1,
                    help="drop runs with fewer tool calls than this")
    args = ap.parse_args()

    runs = rows("""select json_agg(t) from (
        select r.id, r.thread_id as thread, r.question, r.answer, r.created_at
        from runs r
        where r.ok and r.answer <> '' and r.question <> ''
          and exists (select 1 from run_steps s where s.run_id = r.id)
        order by r.thread_id, r.created_at
    ) t;""")
    steps_by_run = {}
    for s in rows("""select json_agg(t) from (
        select run_id, step_index, tool, args, result, ok
        from run_steps order by run_id, step_index
    ) t;"""):
        steps_by_run.setdefault(s["run_id"], []).append(s)

    kept = dropped_skill = dropped_thin = 0
    with open(args.out, "w") as f:
        for r in runs:
            steps = steps_by_run.get(r["id"], [])
            if len(steps) < args.min_steps:
                dropped_thin += 1
                continue
            if args.skill:
                used = any(
                    s["tool"] == args.skill
                    or (s["tool"] == "use_skill" and args.skill in (s["args"] or ""))
                    for s in steps)
                if not used:
                    dropped_skill += 1
                    continue
            messages = [{"role": "user", "content": r["question"]}]
            for s in steps:
                messages.append({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "type": "function",
                        "function": {"name": s["tool"], "arguments": s["args"] or "{}"},
                    }],
                })
                result = s["result"] or ""
                if args.max_result and len(result) > args.max_result:
                    result = result[:args.max_result] + "\n…[truncated for training]"
                messages.append({"role": "tool", "name": s["tool"], "content": result})
            messages.append({"role": "assistant", "content": r["answer"]})
            f.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")
            kept += 1

    print(f"wrote {kept} samples to {args.out}"
          + (f" ({dropped_skill} dropped by --skill)" if args.skill else "")
          + (f" ({dropped_thin} dropped under --min-steps)" if dropped_thin else ""))
    return 0 if kept > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
