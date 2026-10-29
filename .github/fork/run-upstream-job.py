#!/usr/bin/env python3
"""Run one job of upstream's deploy.yml on this runner, step by step.

Fork-only (fork-nightly.yml). The nightly build tests the merged deploy branch
with upstream's own test jobs instead of a copy of them, so suites and fixture
steps that upstream adds are picked up on the next run without editing this
fork. Only the `run:` steps are executed; the setup actions (checkout, Go,
Node) are done by fork-nightly.yml itself, with the versions --versions reads
from the same file.

Anything this script does not understand (a new action, an unfamiliar `if:`,
an expression in a script or env value) stops the run with an error rather
than being guessed at: a test step silently skipped is worse than a red build.

The run is evaluated as a scheduled run, so steps meant only for pushes
(coverage, badges) or pull requests are skipped.

Usage:
  run-upstream-job.py <job> [--shard N] [--dry-run] [--workflow PATH]
  run-upstream-job.py --versions [--workflow PATH]
"""
import argparse
import collections
import json
import os
import re
import subprocess
import sys
import tempfile

import yaml

DEFAULT_WORKFLOW = ".github/workflows/deploy.yml"
EVENT_NAME = "schedule"
# Actions whose work fork-nightly.yml does itself, or that only move
# artifacts between upstream's jobs (badges, shard results).
SKIPPED_ACTIONS = {
    "actions/checkout",
    "actions/setup-go",
    "actions/setup-node",
    "actions/upload-artifact",
    "actions/download-artifact",
}

RUN, SKIP, ALWAYS = "run", "skip", "always"
FAILURE_TAIL_LINES = 40


class Unsupported(Exception):
    pass


def strip_expr(text):
    text = str(text).strip()
    m = re.fullmatch(r"\$\{\{(.*)\}\}", text, re.S)
    return m.group(1).strip() if m else text


def decide(cond, shard):
    """RUN, SKIP or ALWAYS for a step's `if:` on a scheduled run."""
    if cond is None:
        return RUN
    always = False
    for term in (t.strip() for t in strip_expr(cond).split("&&")):
        if term == "success()":
            continue
        if term == "always()":
            always = True
            continue
        m = re.fullmatch(r"github\.event_name\s*(==|!=)\s*'(\w+)'", term)
        if m:
            if (EVENT_NAME == m.group(2)) != (m.group(1) == "=="):
                return SKIP
            continue
        m = re.fullmatch(r"matrix\.shard\s*==\s*(\d+)", term)
        if m:
            if shard is None:
                raise Unsupported(f"condition needs --shard: {cond!r}")
            if int(m.group(1)) != shard:
                return SKIP
            continue
        raise Unsupported(f"unknown condition: {cond!r}")
    return ALWAYS if always else RUN


def substitute(text, shard, where):
    """Replace the expressions this script can evaluate; refuse the rest."""

    def repl(m):
        expr = m.group(1).strip()
        if expr == "matrix.shard" and shard is not None:
            return str(shard)
        t = re.fullmatch(r"github\.event_name\s*==\s*'(\w+)'\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'", expr)
        if t:
            return t.group(2) if EVENT_NAME == t.group(1) else t.group(3)
        raise Unsupported(f"unknown expression in {where}: ${{{{ {expr} }}}}")

    return re.sub(r"\$\{\{(.*?)\}\}", repl, str(text))


def shell_cmd(shell):
    # The shells GitHub runs for `shell: bash` and for no shell at all.
    if shell == "bash":
        return ["bash", "--noprofile", "--norc", "-eo", "pipefail"]
    if shell is None:
        return ["bash", "-e"]
    raise Unsupported(f"unsupported shell: {shell!r}")


def plan(workflow, job_name, shard):
    """The steps to run, as dicts: name, action, script, env, cwd, shell, coe."""
    job = workflow["jobs"].get(job_name)
    if job is None:
        raise Unsupported(f"no job {job_name!r} in the workflow")
    defaults = (job.get("defaults") or {}).get("run") or {}
    job_env = {k: substitute(v, shard, f"{job_name}.env.{k}") for k, v in (job.get("env") or {}).items()}
    steps = []
    for step in job.get("steps") or []:
        name = step.get("name") or step.get("uses") or "(unnamed)"
        action = decide(step.get("if"), shard)
        if "uses" in step:
            if step["uses"].split("@")[0] not in SKIPPED_ACTIONS:
                raise Unsupported(f"step {name!r} uses {step['uses']}, which this script does not handle")
            continue
        if action == SKIP:
            steps.append({"name": name, "action": SKIP})
            continue
        env = dict(job_env)
        for k, v in (step.get("env") or {}).items():
            env[k] = substitute(v, shard, f"step {name!r} env {k}")
        steps.append({
            "name": name,
            "action": action,
            "script": substitute(step["run"], shard, f"step {name!r}"),
            "env": env,
            "cwd": step.get("working-directory") or defaults.get("working-directory"),
            "shell": shell_cmd(step.get("shell") or defaults.get("shell")),
            "coe": bool(step.get("continue-on-error")),
        })
    return steps


RUNNER_OUTPUTS = {"go-test": "go_runs_on", "race-test": "race_runs_on", "e2e-shard": "e2e_runs_on"}


def versions(workflow):
    """go_version, node_version, the E2E shard list and each test job's runner
    (JSON, for fromJSON in runs-on), as GITHUB_OUTPUT lines."""
    found = {}
    for job_name, key in RUNNER_OUTPUTS.items():
        runs_on = (workflow["jobs"].get(job_name) or {}).get("runs-on")
        if not isinstance(runs_on, str) or "${{" in runs_on or not runs_on.startswith("ubuntu"):
            raise Unsupported(f"{job_name} runs-on is not a GitHub-hosted ubuntu label: {runs_on!r}")
        found[key] = json.dumps(runs_on)
    for job in workflow["jobs"].values():
        for step in job.get("steps") or []:
            uses = (step.get("uses") or "").split("@")[0]
            with_ = step.get("with") or {}
            if uses == "actions/setup-go" and "go-version" in with_:
                found.setdefault("go_version", str(with_["go-version"]))
            if uses == "actions/setup-node" and "node-version" in with_:
                found.setdefault("node_version", str(with_["node-version"]))
    shards = (((workflow["jobs"].get("e2e-shard") or {}).get("strategy") or {}).get("matrix") or {}).get("shard")
    if not shards or not all(isinstance(s, int) for s in shards):
        raise Unsupported(f"e2e-shard matrix is not a list of shard numbers: {shards!r}")
    found["shards"] = json.dumps(shards)
    for key in ("go_version", "node_version"):
        if key not in found:
            raise Unsupported(f"no {key} found in the workflow")
    return found


def execute(steps):
    failed = False
    for step in steps:
        if step["action"] == SKIP:
            print(f"--- skipped: {step['name']}", flush=True)
            continue
        if failed and step["action"] != ALWAYS:
            print(f"--- not run (earlier step failed): {step['name']}", flush=True)
            continue
        print(f"::group::{step['name']}", flush=True)
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
            f.write(step["script"])
        # Stream the output, keeping its tail: GitHub shows a group folded, so
        # a failure's last lines are printed again outside it.
        tail = collections.deque(maxlen=FAILURE_TAIL_LINES)
        proc = subprocess.Popen(step["shell"] + [f.name], env={**os.environ, **step["env"]}, cwd=step["cwd"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
        for line in proc.stdout:
            sys.stdout.write(line)
            tail.append(line)
        rc = proc.wait()
        os.unlink(f.name)
        print("::endgroup::", flush=True)
        if rc != 0 and not step["coe"]:
            print(f"--- last {len(tail)} lines of {step['name']}:", flush=True)
            sys.stdout.write("".join(tail))
        if rc != 0:
            if step["coe"]:
                print(f"::warning::{step['name']} failed (exit {rc}), continue-on-error", flush=True)
            else:
                print(f"::error::{step['name']} failed (exit {rc})", flush=True)
                failed = True
    return 1 if failed else 0


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("job", nargs="?")
    p.add_argument("--shard", type=int)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--versions", action="store_true")
    p.add_argument("--workflow", default=DEFAULT_WORKFLOW)
    args = p.parse_args(argv)
    with open(args.workflow) as f:
        workflow = yaml.safe_load(f)
    try:
        if args.versions:
            for k, v in versions(workflow).items():
                print(f"{k}={v}")
            return 0
        if not args.job:
            p.error("a job name is required")
        steps = plan(workflow, args.job, args.shard)
    except Unsupported as e:
        print(f"::error::{args.workflow}: {e}. Update .github/fork/run-upstream-job.py.", flush=True)
        return 2
    if args.dry_run:
        for s in steps:
            print(f"{s['action']:6} {s['name']}")
        return 0
    return execute(steps)


if __name__ == "__main__":
    sys.exit(main())
