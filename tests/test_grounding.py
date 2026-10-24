"""Evidence grounding for the research agents (agents/specialists.py, agents/tools.py)."""

import json
from datetime import datetime, timezone

import pytest

import job_signals
import reviews
from agents import specialists, tools
from agents.schemas import Finding

THIS_YEAR = datetime.now(timezone.utc).year


def recorder_with(*items):
    rec = tools.Recorder()
    rec.add_results([{"title": t, "url": u, "content": c} for u, t, c in items], "tavily")
    return rec


def finding(url, stance, claim="claim", date=None, about=True):
    return Finding(claim=claim, stance=stance, source_url=url, date=date, about_company=about)


def test_findings_with_urls_no_tool_returned_are_dropped():
    rec = recorder_with(("https://reddit.com/r/x/1", "Acme internship", "Acme never paid my stipend"))
    kept, trace = specialists.grounded(
        [finding("https://reddit.com/r/x/1", "complaint"), finding("https://made-up.example/post", "scam_report")],
        rec, specialists.REPUTATION_STANCES)
    assert [record["url"] for _, record in kept] == ["https://reddit.com/r/x/1"]
    assert trace[1]["grounded"] is False and trace[1]["counted"] is False


def test_unknown_stance_is_grounded_but_not_counted():
    rec = recorder_with(("https://news.example/a", "Acme", "Acme raised money"))
    kept, trace = specialists.grounded([finding("https://news.example/a", "neutral")], rec, specialists.FUNDING_STANCES)
    assert kept == [] and trace[0]["grounded"] is True and trace[0]["counted"] is False


def test_url_matching_ignores_trailing_slash_and_fragment():
    rec = recorder_with(("https://reddit.com/r/x/1/", "Acme", "text"))
    kept, _ = specialists.grounded([finding("https://reddit.com/r/x/1#comments", "positive")], rec,
                                   specialists.REPUTATION_STANCES)
    assert len(kept) == 1


def test_evidence_shown_is_the_recorded_snippet_not_the_model_text():
    rec = recorder_with(("https://reddit.com/r/x/1", "Acme", "REAL SNIPPET: Acme took a fee from me"))
    kept, _ = specialists.grounded([finding("https://reddit.com/r/x/1", "scam_report", claim="model wording")], rec,
                                   specialists.REPUTATION_STANCES)
    signals, _ = specialists.reputation_signals("Acme", kept)
    assert signals[0]["evidence"].startswith("REAL SNIPPET")


def test_recent_funding_from_a_credible_source_is_a_medium_bonus():
    rec = recorder_with(("https://inc42.com/buzz/acme-raises", "Acme raises $2M seed", f"Acme raised $2M in {THIS_YEAR}."))
    kept, _ = specialists.grounded([finding("https://inc42.com/buzz/acme-raises", "funding_round", date=str(THIS_YEAR))],
                                   rec, specialists.FUNDING_STANCES)
    signals, _ = specialists.funding_signals("Acme", kept)
    assert signals[0]["id"] == "funding_recent" and signals[0]["weight"] == "medium" and signals[0]["counted"]
    assert signals[0]["polarity"] == "positive"


def test_funding_from_an_unlisted_site_is_shown_but_not_counted():
    rec = recorder_with(("https://randomblog.example/acme", "Acme raises money", f"Acme raised $2M in {THIS_YEAR}."))
    kept, _ = specialists.grounded([finding("https://randomblog.example/acme", "funding_round")], rec,
                                   specialists.FUNDING_STANCES)
    signals, _ = specialists.funding_signals("Acme", kept)
    assert signals[0]["counted"] is False and signals[0]["not_counted_reason"]


def test_a_claimed_year_that_is_not_in_the_snippet_is_ignored():
    rec = recorder_with(("https://inc42.com/acme", "Acme raises seed round", "Acme raised $2M in 2015."))
    kept, _ = specialists.grounded([finding("https://inc42.com/acme", "funding_round", date=str(THIS_YEAR))], rec,
                                   specialists.FUNDING_STANCES)
    signals, _ = specialists.funding_signals("Acme", kept)
    assert signals[0]["id"] == "funding_older" and signals[0]["weight"] == "low"


def test_funding_about_another_company_is_ignored():
    rec = recorder_with(("https://inc42.com/other", "Globex raises $5M", "Globex raised $5M this year."))
    kept, _ = specialists.grounded([finding("https://inc42.com/other", "funding_round")], rec, specialists.FUNDING_STANCES)
    signals, check = specialists.funding_signals("Acme", kept)
    assert signals == [] and "neutral" in check["detail"]


def test_no_funding_found_is_neutral():
    signals, check = specialists.funding_signals("Acme", [])
    assert signals == [] and check["status"] == "ok"


def test_credible_news_list_lives_in_job_signals():
    assert "inc42.com" in job_signals.CREDIBLE_NEWS_DOMAINS


# -----------------------------
# tools
# -----------------------------

def test_search_queries_only_carry_the_company_name_and_plain_keywords(monkeypatch):
    sent = []
    monkeypatch.setattr(reviews, "tavily_search", lambda key, query, domains=None, n=5: sent.append(query) or [
        {"title": "t", "url": "https://example.org/a", "content": "c"}])
    rec = tools.Recorder()
    search = tools.SearchTools("Acme Labs", "key", tools.Budget(6), rec)
    search.search_web("internship review hr@acme.com 9876543210 https://bit.ly/x")
    assert sent == ['"Acme Labs" internship review']
    assert rec.lookup("https://example.org/a") is not None


def test_duckduckgo_is_used_when_the_tavily_budget_is_spent(monkeypatch):
    monkeypatch.setattr(reviews, "tavily_search", lambda *a, **k: pytest.fail("Tavily should not be called"))
    monkeypatch.setattr(tools, "_ddg_search", lambda query, reddit=False: [
        {"title": "d", "url": "https://ddg.example/r", "content": "c"}])
    rec = tools.Recorder()
    out = json.loads(tools.SearchTools("Acme", "key", tools.Budget(0), rec).search_web("review"))
    assert out["results"][0]["url"] == "https://ddg.example/r" and rec.engines == {"duckduckgo"}


def test_duckduckgo_is_used_when_tavily_fails(monkeypatch):
    def broken(*a, **k):
        raise reviews.ReviewError("quota", "used up")
    monkeypatch.setattr(reviews, "tavily_search", broken)
    monkeypatch.setattr(tools, "_ddg_search", lambda query, reddit=False: [])
    rec = tools.Recorder()
    tools.SearchTools("Acme", "key", tools.Budget(6), rec).search_web("review")
    assert rec.engines == {"duckduckgo"}


def test_company_tools_refuse_domains_they_were_not_given():
    rec = tools.Recorder()
    company = tools.CompanyTools(["acme.com"], "acme.com", ["acme"], "acme", "acme.com", "", rec)
    out = json.loads(company.check_domain_age("evil.example"))
    assert "error" in out and rec.checks == []
