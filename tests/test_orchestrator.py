"""The orchestrator: parallel agents, timeouts, fallbacks and skips (no network, no real models)."""

import time

import pytest
from agno.run.base import RunStatus

from agents import orchestrator, specialists
from agents.schemas import AgentOutput, Finding
from conftest import signal

TEXT = "Intern at Acme Labs. Contact jobs@acmelabs.com"


class FakeRun:
    def __init__(self, content, status=RunStatus.completed):
        self.content, self.status = content, status


class FakeAgent:
    """Optionally records fake tool results, waits, then returns a structured answer (or raises)."""

    def __init__(self, recorder, output=None, results=(), delay=0.0, error=None, status=RunStatus.completed):
        self.recorder, self.output, self.results = recorder, output or AgentOutput(), results
        self.delay, self.error, self.status = delay, error, status

    def run(self, prompt):
        self.recorder.count_call()
        if self.results:
            self.recorder.add_results(list(self.results), "tavily")
        time.sleep(self.delay)
        if self.error:
            raise self.error
        return FakeRun(self.output, self.status)


@pytest.fixture
def no_models(monkeypatch):
    monkeypatch.setattr(orchestrator, "_models", lambda: ({k: None for k in orchestrator.AGENTS}, None))


def patch_agents(monkeypatch, reputation=None, company=None, funding=None):
    """Each argument is a function(recorder) -> FakeAgent."""
    if reputation:
        monkeypatch.setattr(specialists, "reputation_agent", lambda m, p, c, k, b, rec, l: (reputation(rec), "q"))
    if funding:
        monkeypatch.setattr(specialists, "funding_agent", lambda m, p, c, k, b, rec, l: (funding(rec), "q"))
    if company:
        monkeypatch.setattr(specialists, "company_agent", lambda m, p, d, w, wo, j, cd, r, rec, l: (company(rec), "q"))


def research(**kwargs):
    defaults = dict(client=None, model="m", text=TEXT, company="Acme Labs", website="acmelabs.com",
                    tavily_key="key", use_agents=True)
    defaults.update(kwargs)
    return orchestrator.research(**defaults)


def status_of(out, key):
    return next(a for a in out["agents"] if a["id"] == key)["status"]


def test_agents_run_in_parallel_not_one_after_another(monkeypatch, no_models):
    slow = lambda rec: FakeAgent(rec, delay=0.4)
    patch_agents(monkeypatch, reputation=slow, company=slow, funding=slow)
    started = time.time()
    out = research()
    assert time.time() - started < 1.0          # three 0.4s agents in parallel, not 1.2s
    assert [a["status"] for a in out["agents"]] == ["done", "done", "done"]


def test_timed_out_agents_are_unavailable_and_the_standard_checks_run(monkeypatch, no_models):
    monkeypatch.setattr(orchestrator, "AGENT_TIMEOUT", 0.3)
    hang = lambda rec: FakeAgent(rec, delay=2.0)
    patch_agents(monkeypatch, reputation=hang, company=hang, funding=hang)
    called = []
    fallback_checks = lambda *a: called.append("checks") or ([signal("domain_established", "positive", "low")],
                                                             [{"name": "Domain", "status": "ok", "detail": ""}])
    fallback_reviews = lambda *a: called.append("reviews") or ([], {"name": "Web", "status": "ok", "detail": ""})
    out = research(run_checks=fallback_checks, run_reviews=fallback_reviews)
    assert {a["id"]: a["status"] for a in out["agents"]} == {"reputation": "unavailable", "company": "unavailable",
                                                             "funding": "unavailable"}
    assert sorted(called) == ["checks", "reviews"]
    assert any(s["id"] == "domain_established" for s in out["signals"])
    assert "took too long" in out["agents"][0]["note"]


def test_an_agent_that_errors_falls_back_without_crashing(monkeypatch, no_models):
    patch_agents(monkeypatch,
                 reputation=lambda rec: FakeAgent(rec, error=RuntimeError("rate limited")),
                 company=lambda rec: FakeAgent(rec, status=RunStatus.error),
                 funding=lambda rec: FakeAgent(rec))
    out = research(run_checks=lambda *a: ([], []), run_reviews=lambda *a: ([], {"name": "Web", "status": "ok", "detail": ""}))
    assert status_of(out, "reputation") == "unavailable"
    assert status_of(out, "company") == "unavailable"
    assert status_of(out, "funding") == "done"


def test_if_the_agent_framework_fails_everything_falls_back(monkeypatch):
    def broken():
        raise ImportError("agno missing")
    monkeypatch.setattr(orchestrator, "_models", broken)
    out = research(run_checks=lambda *a: ([], [{"name": "Domain", "status": "ok", "detail": ""}]),
                   run_reviews=lambda *a: ([], {"name": "Web", "status": "ok", "detail": ""}))
    assert [a["status"] for a in out["agents"]] == ["unavailable"] * 3
    assert [c["name"] for c in out["checks"]] == ["Domain", "Web"]


def test_missing_company_name_skips_the_company_dependent_agents(monkeypatch, no_models):
    patch_agents(monkeypatch, company=lambda rec: FakeAgent(rec))
    out = research(company="")
    assert status_of(out, "reputation") == "skipped" and status_of(out, "funding") == "skipped"
    assert status_of(out, "company") == "done"
    assert "No company name" in out["agents"][0]["note"]


def test_missing_website_and_domain_skips_the_company_agent(monkeypatch, no_models):
    patch_agents(monkeypatch, reputation=lambda rec: FakeAgent(rec), funding=lambda rec: FakeAgent(rec))
    out = research(text="Intern at Acme Labs. Contact acme.hr@gmail.com", website="")
    assert status_of(out, "company") == "skipped"


def test_agents_disabled_uses_the_old_path(no_models):
    out = research(use_agents=False, run_checks=lambda *a: ([], [{"name": "Domain", "status": "ok", "detail": ""}]),
                   run_reviews=lambda *a: ([], {"name": "Web", "status": "ok", "detail": ""}))
    assert out["agents"] == [] and [c["name"] for c in out["checks"]] == ["Domain", "Web"]


def test_live_lookups_off_skips_all_research(no_models):
    out = research(live_lookups=False)
    assert out["agents"] == [] and out["checks"][0]["status"] == "skipped"


def test_only_grounded_findings_become_signals(monkeypatch, no_models):
    real = {"title": "Acme Labs internship", "url": "https://reddit.com/r/x/1", "content": "Acme Labs charged me a fee"}
    findings = AgentOutput(findings=[
        Finding(claim="took a fee", stance="scam_report", source_url=real["url"]),
        Finding(claim="invented", stance="scam_report", source_url="https://made-up.example/x"),
    ], summary="model summary that must not be shown")
    patch_agents(monkeypatch, reputation=lambda rec: FakeAgent(rec, output=findings, results=[real]),
                 company=lambda rec: FakeAgent(rec), funding=lambda rec: FakeAgent(rec))
    out = research()
    reputation = next(a for a in out["agents"] if a["id"] == "reputation")
    assert [f["grounded"] for f in reputation["findings"]] == [True, False]
    assert "model summary" not in reputation["note"]
    assert "not counted" in reputation["note"]
    fraud = next(s for s in out["signals"] if s["id"] == "public_scam_reports")
    assert fraud["weight"] == "medium"        # one grounded report, not two
    assert fraud["evidence"] == real["content"]


def test_results_are_cached_per_company(monkeypatch, no_models):
    runs = []
    patch_agents(monkeypatch, reputation=lambda rec: runs.append(1) or FakeAgent(rec),
                 company=lambda rec: FakeAgent(rec), funding=lambda rec: FakeAgent(rec))
    research()
    second = research()
    assert len(runs) == 1
    assert all("cached" in a["note"] for a in second["agents"])
