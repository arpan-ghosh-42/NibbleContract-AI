"""
Runs the research agents in parallel and turns what they found into signals.

- Reputation, company and funding agents start together; total time is about
  the slowest agent, not the sum. Each has a tool-call cap and a time limit,
  and the whole research step has its own budget.
- Agents only gather evidence. Findings are grounded against what the tools
  really returned, then plain code turns them into signals.
- If Agno or an agent fails, the matching non-agent check runs instead
  (lookups.run_checks, reviews.check_reputation) and the agent is marked
  "unavailable". Nothing here can crash a report.
"""

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import authenticity
import lookups
import reviews

AGENT_TIMEOUT = 20          # seconds per agent
RESEARCH_BUDGET = 35        # seconds for the whole research step, fallbacks included
TOOL_CALL_LIMIT = 3
TAVILY_CREDITS = 6          # per check (basic search = 1 credit)
CACHE_SECONDS = 6 * 3600

AGENTS = {
    "reputation": "Reputation agent",
    "company": "Company agent",
    "funding": "Funding agent",
}
ROLES = {
    "reputation": "Scam reports, complaints and real experiences on the web and Reddit",
    "company": "Domain age, website and careers page",
    "funding": "Funding news from established news sites",
}

_cache = {}
_cache_lock = threading.Lock()
log = logging.getLogger(__name__)


def agents_enabled():
    return os.getenv("AGENTS_ENABLED", "1") != "0"


# One model per agent, in this order. Groq's free tier limits tokens per minute per model, so the load is spread:
# the post analyst already uses GROQ_MODEL (gpt-oss-120b).
DEFAULT_AGENT_MODELS = "openai/gpt-oss-20b,openai/gpt-oss-120b,openai/gpt-oss-20b"
DEFAULT_PARSER_MODEL = "openai/gpt-oss-120b"


def _models():
    """Return ({agent_key: model}, parser_model)."""
    from agno.models.groq import Groq
    names = [m.strip() for m in os.getenv("GROQ_AGENT_MODELS", DEFAULT_AGENT_MODELS).split(",") if m.strip()]
    names = (names or DEFAULT_AGENT_MODELS.split(","))
    parser = os.getenv("GROQ_PARSER_MODEL", DEFAULT_PARSER_MODEL).strip() or DEFAULT_PARSER_MODEL

    def build(name):
        extra = {"request_params": {"reasoning_effort": "low"}} if name.startswith("openai/gpt-oss") else {}
        # One quick retry at most: waiting out a rate limit would blow the time budget, and the fallback covers it.
        return Groq(id=name, timeout=AGENT_TIMEOUT, max_retries=1, **extra)

    return {key: build(names[i % len(names)]) for i, key in enumerate(AGENTS)}, build(parser)


def _trace(key, status, seconds=0.0, recorder=None, note="", findings=None):
    sources = []
    if recorder is not None:
        sources = [{"title": r["title"] or r["url"], "url": r["url"]} for r in recorder.results.values()][:8]
        for check in recorder.checks:
            target = check["name"].split(": ", 1)[-1]
            if target and "." in target:
                sources.append({"title": check["name"], "url": target if target.startswith("http") else f"https://{target}"})
    return {
        "id": key, "name": AGENTS[key], "role": ROLES[key], "status": status,
        "duration_ms": int(seconds * 1000),
        "tool_calls": recorder.tool_calls if recorder is not None else 0,
        "engines": sorted(recorder.engines) if recorder is not None else [],
        "sources": sources, "findings": findings or [], "note": note,
    }


def _run_agent(agent, prompt):
    """Return (output, seconds). Raises if the run didn't complete with structured output."""
    from agno.run.base import RunStatus
    from agents.schemas import AgentOutput
    started = time.time()
    run = agent.run(prompt)
    # Agno reports model errors as a run status, not an exception.
    if run.status != RunStatus.completed:
        raise RuntimeError(f"agent run ended with status {run.status}")
    if not isinstance(run.content, AgentOutput):
        raise RuntimeError("agent returned no structured output")
    return run.content, time.time() - started


def research(client, model, text, company, website, sender_email="", role="", live_lookups=True, tavily_key="",
             run_checks=None, run_reviews=None, use_agents=None):
    """Return {"signals", "checks", "agents"}. Never raises."""
    if not live_lookups:
        return {"signals": [], "agents": [],
                "checks": [{"name": "Online lookups", "status": "skipped", "detail": "Online lookups are turned off on this server."}]}

    domains, site_target, contact_domain = authenticity.lookup_targets(text, sender_email, website)
    words, joined = authenticity._company_tokens(company)
    fallback_checks = run_checks or lookups.run_checks
    fallback_reviews = run_reviews or reviews.check_reputation
    use_agents = agents_enabled() if use_agents is None else use_agents

    if not use_agents:
        return _fallback_only(client, model, company, tavily_key, domains, site_target, words, joined, contact_domain,
                              fallback_checks, fallback_reviews)

    cache_key = (company.lower(), tuple(domains), (site_target or "").lower(), (role or "").lower())
    with _cache_lock:
        hit = _cache.get(cache_key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        cached = dict(hit[1])
        cached["agents"] = [dict(a, note=(a["note"] + " (cached result)").strip()) for a in cached["agents"]]
        return cached

    try:
        from agents import specialists
        from agents.tools import Budget, Recorder
        agent_models, parser = _models()
    except Exception:
        out = _fallback_only(client, model, company, tavily_key, domains, site_target, words, joined, contact_domain,
                             fallback_checks, fallback_reviews)
        out["agents"] = [_trace(k, "unavailable", note="The agent framework couldn't start; the standard check ran instead.")
                         for k in AGENTS]
        return out

    started = time.time()
    budget = Budget(TAVILY_CREDITS if tavily_key else 0)
    recorders = {k: Recorder() for k in AGENTS}
    has_company = len(joined) >= 3
    plan, skipped = {}, {}

    if has_company:
        plan["reputation"] = specialists.reputation_agent(agent_models["reputation"], parser, company, tavily_key, budget,
                                                          recorders["reputation"], TOOL_CALL_LIMIT)
        plan["funding"] = specialists.funding_agent(agent_models["funding"], parser, company, tavily_key, budget,
                                                    recorders["funding"], TOOL_CALL_LIMIT)
    else:
        skipped["reputation"] = skipped["funding"] = "No company name, so there was nothing to search for. Add it in the company field."
    if domains or site_target:
        plan["company"] = specialists.company_agent(agent_models["company"], parser, domains, site_target, words, joined,
                                                    contact_domain, role, recorders["company"], TOOL_CALL_LIMIT)
    else:
        skipped["company"] = "No company website or company email domain to check."

    pool = ThreadPoolExecutor(max_workers=max(1, len(plan)))
    futures = {key: pool.submit(_run_agent, agent, prompt) for key, (agent, prompt) in plan.items()}
    outputs, failures, seconds = {}, {}, {}
    for key, future in futures.items():
        remaining = max(0.1, started + AGENT_TIMEOUT - time.time())
        try:
            outputs[key], seconds[key] = future.result(timeout=remaining)
        except Exception as e:
            seconds[key] = time.time() - started
            failures[key] = "it took too long" if type(e).__name__ == "TimeoutError" else "it failed this time"
            # Errors come from the model API or tools and never contain the user's document.
            log.warning("agent %s unavailable: %s %s", key, type(e).__name__, str(e)[:200])
    pool.shutdown(wait=False, cancel_futures=True)   # a timed-out agent finishes in the background and is ignored

    signals, checks, trace = [], [], []
    for key in AGENTS:
        rec = recorders[key]
        if key in skipped:
            trace.append(_trace(key, "skipped", note=skipped[key]))
            continue
        if key in failures:
            sigs, chks, note = _fallback_for(key, failures[key], started, client, model, company, tavily_key, domains,
                                             site_target, words, joined, contact_domain, fallback_checks, fallback_reviews)
            signals += sigs
            checks += chks
            trace.append(_trace(key, "unavailable", seconds[key], rec, note))
            continue

        output = outputs[key]
        if key == "company":
            sigs, chks = list(rec.signals), list(rec.checks)
            findings = [{"claim": c["detail"], "stance": c["status"], "source_url": c["name"].split(": ", 1)[-1],
                         "grounded": True, "counted": True, "about_company": True} for c in rec.checks]
            if not chks:
                chks = [{"name": "Company checks", "status": "unavailable", "detail": "the agent didn't run any checks"}]
        elif key == "reputation":
            kept, findings = specialists.grounded(output.findings, rec, specialists.REPUTATION_STANCES)
            sigs, chk = specialists.reputation_signals(company, kept)
            chks = [chk]
        else:
            kept, findings = specialists.grounded(output.findings, rec, specialists.FUNDING_STANCES)
            sigs, chk = specialists.funding_signals(company, kept)
            chks = [chk]
        signals += sigs
        checks += chks
        # The note is built from what was counted, never from the model's own summary.
        note = "; ".join(f"{c['name']}: {c['detail']}" for c in chks)
        dropped = sum(1 for f in findings if not f["grounded"])
        if dropped:
            note += f". {dropped} finding(s) cited a link no tool returned, so they were not counted."
        trace.append(_trace(key, "done", seconds[key], rec, note, findings))

    if any(s["id"] == "domain_unregistered" for s in signals):
        signals = [s for s in signals if s["id"] != "website_missing"]
    result = {"signals": signals, "checks": checks, "agents": trace}
    if not failures:
        with _cache_lock:
            _cache[cache_key] = (time.time(), result)
    return result


def _fallback_for(key, reason, started, client, model, company, tavily_key, domains, site_target, words, joined,
                  contact_domain, fallback_checks, fallback_reviews):
    """The non-agent check for one failed agent, if the research budget allows. Returns (signals, checks, note)."""
    left = started + RESEARCH_BUDGET - time.time()
    if left < 3:
        return [], [], f"The agent stopped because {reason}, and there was no time left for the standard check."
    try:
        if key == "company":
            sigs, chks = fallback_checks(domains, site_target, words, joined, contact_domain)
            return list(sigs), list(chks), f"The agent stopped because {reason}; the standard domain and website checks ran instead."
        if key == "reputation" and tavily_key:
            sigs, chk = fallback_reviews(client, model, company, tavily_key)
            return list(sigs), [chk], f"The agent stopped because {reason}; the standard web search ran instead."
    except Exception:
        return [], [], f"The agent stopped because {reason}, and the standard check failed too."
    return [], [], f"The agent stopped because {reason}."


def _fallback_only(client, model, company, tavily_key, domains, site_target, words, joined, contact_domain,
                   fallback_checks, fallback_reviews):
    """The original non-agent research path (AGENTS_ENABLED=0)."""
    signals, checks = [], []
    try:
        found, done = fallback_checks(domains, site_target, words, joined, contact_domain)
        signals, checks = list(found), list(done)
    except Exception:
        checks.append({"name": "Domain and website checks", "status": "unavailable", "detail": "the checks failed this time"})
    if tavily_key:
        try:
            found, done = fallback_reviews(client, model, company, tavily_key)
            signals += found
            checks.append(done)
        except Exception:
            checks.append({"name": "Web & Reddit search", "status": "unavailable", "detail": "the review search failed this time"})
    else:
        checks.append({"name": "Web & Reddit search", "status": "skipped",
                       "detail": "Add TAVILY_API_KEY to .env to search for public reviews and fraud reports."})
    return {"signals": signals, "checks": checks, "agents": []}
