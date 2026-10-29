#!/usr/bin/env python3
"""Tests for run-upstream-job.py. Run: python3 .github/fork/test_run_upstream_job.py"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location("ruj", os.path.join(HERE, "run-upstream-job.py"))
ruj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ruj)


def wf(steps, **job):
    return {"jobs": {"j": {"steps": steps, **job}}}


class Decide(unittest.TestCase):
    def test_no_condition_runs(self):
        self.assertEqual(ruj.decide(None, None), ruj.RUN)

    def test_push_and_pr_only_steps_are_skipped(self):
        self.assertEqual(ruj.decide("github.event_name == 'pull_request'", None), ruj.SKIP)
        self.assertEqual(ruj.decide("success() && github.event_name == 'push'", 1), ruj.SKIP)

    def test_not_pr_runs(self):
        self.assertEqual(ruj.decide("github.event_name != 'pull_request'", None), ruj.RUN)

    def test_shard(self):
        self.assertEqual(ruj.decide("matrix.shard == 3", 3), ruj.RUN)
        self.assertEqual(ruj.decide("matrix.shard == 3", 1), ruj.SKIP)
        with self.assertRaises(ruj.Unsupported):
            ruj.decide("matrix.shard == 3", None)

    def test_always_and_wrapped(self):
        self.assertEqual(ruj.decide("always()", None), ruj.ALWAYS)
        self.assertEqual(ruj.decide("${{ success() }}", None), ruj.RUN)

    def test_unknown_conditions_refuse(self):
        for cond in ("failure()", "github.ref == 'refs/heads/master'",
                     "(github.event_name == 'push' || matrix.shard == 1)"):
            with self.assertRaises(ruj.Unsupported, msg=cond):
                ruj.decide(cond, 1)


class Plan(unittest.TestCase):
    def test_setup_actions_skipped_unknown_action_refused(self):
        steps = ruj.plan(wf([{"uses": "actions/checkout@v5"}, {"name": "a", "run": "true"}]), "j", None)
        self.assertEqual([s["name"] for s in steps], ["a"])
        with self.assertRaises(ruj.Unsupported):
            ruj.plan(wf([{"uses": "docker/login-action@v3"}]), "j", None)

    def test_expressions(self):
        steps = ruj.plan(wf(
            [{"name": "a", "run": "echo ${{ matrix.shard }}",
              "env": {"N": "${{ github.event_name == 'push' && '--x' || '' }}"}}],
            env={"SHARD": "${{ matrix.shard }}", "E2E_SHARDS": 3}), "j", 2)
        self.assertEqual(steps[0]["script"], "echo 2")
        self.assertEqual(steps[0]["env"], {"SHARD": "2", "E2E_SHARDS": "3", "N": ""})
        with self.assertRaises(ruj.Unsupported):
            ruj.plan(wf([{"name": "a", "run": "echo ${{ secrets.X }}"}]), "j", None)

    def test_shells(self):
        steps = ruj.plan(wf([{"name": "a", "run": "x"}, {"name": "b", "run": "x", "shell": "bash"}]), "j", None)
        self.assertEqual(steps[0]["shell"], ["bash", "-e"])
        self.assertIn("pipefail", steps[1]["shell"])
        with self.assertRaises(ruj.Unsupported):
            ruj.plan(wf([{"name": "a", "run": "x", "shell": "pwsh"}]), "j", None)


class Execute(unittest.TestCase):
    def run_steps(self, steps):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "log")
            for s in steps:
                s.setdefault("name", s["run"])
                s["run"] = s["run"].replace("LOG", log)
            path = os.path.join(d, "wf.yml")
            with open(path, "w") as f:
                yaml.safe_dump(wf(steps), f)
            rc = ruj.main(["j", "--workflow", path])
            with open(log) if os.path.exists(log) else open(os.devnull) as f:
                return rc, f.read().split()

    def test_failure_stops_but_always_runs(self):
        rc, ran = self.run_steps([
            {"run": "echo one >> LOG"},
            {"run": "false"},
            {"run": "echo three >> LOG"},
            {"run": "echo cleanup >> LOG", "if": "always()"},
        ])
        self.assertEqual(rc, 1)
        self.assertEqual(ran, ["one", "cleanup"])

    def test_failure_tail_is_repeated_outside_the_group(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc, _ = self.run_steps([{"name": "t", "run": "echo 'X failing case'; exit 1"}])
        out = buf.getvalue()
        self.assertEqual(rc, 1)
        after = out.split("::endgroup::", 1)[1]
        self.assertIn("X failing case", after)

    def test_background_process_does_not_hold_the_step_open(self):
        # The E2E jobs start their test server with `&`; it inherits the
        # output pipe. Waiting for EOF hung every shard for 6 hours.
        start = time.monotonic()
        rc, ran = self.run_steps([
            {"run": "sleep 30 &\necho started >> LOG"},
            {"run": "echo next >> LOG"},
        ])
        self.assertEqual((rc, ran), (0, ["started", "next"]))
        self.assertLess(time.monotonic() - start, 15)

    def test_pipefail_with_bash_and_continue_on_error(self):
        rc, _ = self.run_steps([{"run": "false | true", "shell": "bash"}])
        self.assertEqual(rc, 1)
        rc, ran = self.run_steps([{"run": "false", "continue-on-error": True}, {"run": "echo after >> LOG"}])
        self.assertEqual((rc, ran), (0, ["after"]))


class RealWorkflow(unittest.TestCase):
    """The real deploy.yml must be fully understood, so a nightly never fails on parsing."""

    def setUp(self):
        with open(os.path.join(REPO, ".github/workflows/deploy.yml")) as f:
            self.wf = yaml.safe_load(f)

    def test_versions(self):
        v = ruj.versions(self.wf)
        self.assertTrue(v["go_version"] and v["node_version"])
        self.assertTrue(v["shards"].startswith("["))
        for key in ("go_runs_on", "race_runs_on", "e2e_runs_on"):
            self.assertTrue(json.loads(v[key]).startswith("ubuntu"), key)

    def test_self_hosted_runner_refused(self):
        wf = {"jobs": {j: {"runs-on": ["self-hosted"], "steps": []} for j in ("go-test", "race-test", "e2e-shard")}}
        with self.assertRaises(ruj.Unsupported):
            ruj.versions(wf)

    def test_jobs_plan_and_run_the_tests(self):
        names = lambda job, shard=None: {s["name"]: s["action"] for s in ruj.plan(self.wf, job, shard)}
        go = names("go-test")
        self.assertEqual(go["Run JS unit tests"], ruj.RUN)
        self.assertEqual(go["Build and test Go server (with coverage)"], ruj.RUN)
        self.assertTrue(any("XSS" in n and a == ruj.SKIP for n, a in go.items()))
        self.assertEqual(names("race-test")["go test -race"], ruj.RUN)
        for shard in [int(s) for s in ruj.versions(self.wf)["shards"].strip("[]").split(",")]:
            e2e = names("e2e-shard", shard)
            self.assertEqual(e2e["Run Playwright E2E tests (fail-fast)"], ruj.RUN)
            self.assertEqual(e2e["Stop test server"], ruj.ALWAYS)
            # Push-only coverage collection is skipped; instrumenting stays,
            # because the test server serves public-instrumented/.
            self.assertEqual(e2e["Merge this shard's frontend coverage"], ruj.SKIP)
            self.assertEqual(e2e["Instrument frontend JS for coverage"], ruj.RUN)

    def test_fork_suites_are_in_the_e2e_list(self):
        script = next(s["script"] for s in ruj.plan(self.wf, "e2e-shard", 1)
                      if s["name"].startswith("Run Playwright"))
        for suite in ("test-scope-contours-e2e.js", "test-audio-live-1297-e2e.js"):
            self.assertIn(suite, script)


if __name__ == "__main__":
    unittest.main()
