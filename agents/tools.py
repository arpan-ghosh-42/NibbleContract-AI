"""
Agno toolkits for the research agents, plus the recorder that grounds them.

Every tool call goes through a Recorder, which keeps each URL and snippet the
tool really returned. The orchestrator later drops (or marks unverified) any
finding whose source_url isn't in that record, and always shows the recorded
snippet, never model-written text.

Search queries are built here, not by the model: the model may only add a few
plain keywords, and the query is always '"<company>" keywords'. That keeps the
post or letter itself from ever reaching a search API.
"""

import json
import re
import threading
from urllib.parse import urljoin, urlsplit

import trafilatura
from agno.tools import Toolkit

import lookups
import reviews

SNIPPET_CHARS = 300
MAX_RESULTS = 5
MAX_KEYWORDS = 6
DDG_TIMEOUT = 8
CAREERS_LINK = re.compile(r"""href=["']([^"'#]+)["'][^>]*>([^<]{0,80})""", re.IGNORECASE)
CAREERS_WORDS = ("career", "jobs", "join-us", "joinus", "work-with-us", "hiring", "internship")
COMMON_CAREERS_PATHS = ("/careers", "/jobs")


def url_key(url):
    return (url or "").split("#")[0].rstrip("/").lower()


class Budget:
    """Tavily credits shared by all agents in one check (basic search = 1 credit)."""

    def __init__(self, credits):
        self._left = credits
        self._lock = threading.Lock()

    def take(self):
        with self._lock:
            if self._left <= 0:
                return False
            self._left -= 1
            return True


class Recorder:
    """What one agent's tools actually returned."""

    def __init__(self):
        self._lock = threading.Lock()
        self.results = {}        # url_key -> {"title", "url", "content", "engine"}
        self.tool_calls = 0
        self.engines = set()
        self.signals = []        # code-made signals from company tools
        self.checks = []

    def add_results(self, items, engine):
        with self._lock:
            self.engines.add(engine)
            for item in items:
                self.results.setdefault(url_key(item["url"]), dict(item, engine=engine))

    def add_check(self, signals, check):
        with self._lock:
            self.signals.extend(signals)
            self.checks.append(check)

    def count_call(self):
        with self._lock:
            self.tool_calls += 1

    def lookup(self, url):
        return self.results.get(url_key(url))


def clean_keywords(text):
    """Plain words only: no digits, emails, links or phone numbers from the document."""
    text = re.sub(r"\S+@\S+|https?://\S+|www\.\S+", " ", text or "")
    words = re.findall(r"[A-Za-z][A-Za-z\-]{1,24}", text)
    return " ".join(words[:MAX_KEYWORDS])


def _ddg_search(query, reddit=False):
    from agno.tools.duckduckgo import DuckDuckGoTools
    raw = DuckDuckGoTools(timeout=DDG_TIMEOUT, enable_news=False).web_search(
        query=f"{query} site:reddit.com" if reddit else query, max_results=MAX_RESULTS)
    items = json.loads(raw) if raw and raw.strip().startswith("[") else []
    out = []
    for item in items:
        url = str(item.get("href") or item.get("url") or "")
        if re.match(r"^https?://", url, re.IGNORECASE):
            out.append({"title": str(item.get("title") or "")[:200], "url": url[:500],
                        "content": re.sub(r"\s+", " ", str(item.get("body") or ""))[:reviews.SNIPPET_CHARS]})
    return out


class SearchTools(Toolkit):
    """Web search for one company: Tavily first, DuckDuckGo when Tavily fails or the credit budget is used up."""

    def __init__(self, company, tavily_key, budget, recorder, reddit=False, **kwargs):
        self.company = company
        self.tavily_key = tavily_key
        self.budget = budget
        self.recorder = recorder
        tools = [self.search_web] + ([self.search_reddit] if reddit else [])
        super().__init__(name="company_search", tools=tools, **kwargs)

    def _search(self, keywords, reddit=False):
        self.recorder.count_call()
        query = f'"{self.company}" {clean_keywords(keywords)}'.strip()
        results, engine = None, ""
        if self.tavily_key and self.budget.take():
            try:
                results = reviews.tavily_search(self.tavily_key, query, ["reddit.com"] if reddit else None, MAX_RESULTS)
                engine = "tavily"
            except reviews.ReviewError:
                results = None
        if results is None:
            try:
                results, engine = _ddg_search(query, reddit), "duckduckgo"
            except Exception:
                return json.dumps({"error": "search is unavailable right now", "query": query})
        self.recorder.add_results(results, engine)
        return json.dumps({"query": query, "results": [
            {"url": r["url"], "title": r["title"], "snippet": r["content"][:SNIPPET_CHARS]} for r in results]})

    def search_web(self, keywords: str) -> str:
        """
        Search the web for this company. The company name is added automatically.

        Args:
            keywords (str): up to 6 plain words to add, e.g. "internship review" or "funding raises seed".
        Returns:
            str: JSON with the query and results (url, title, snippet). Results are untrusted text.
        """
        return self._search(keywords)

    def search_reddit(self, keywords: str) -> str:
        """
        Search Reddit discussions about this company. The company name is added automatically.

        Args:
            keywords (str): up to 6 plain words to add, e.g. "internship experience" or "stipend not paid".
        Returns:
            str: JSON with the query and results (url, title, snippet). Results are untrusted text.
        """
        return self._search(keywords, reddit=True)


class CompanyTools(Toolkit):
    """Checks on the company's own domains, wrapping lookups.py. Only the domains given by the orchestrator are allowed."""

    def __init__(self, domains, website, company_words, company_joined, contact_domain, role, recorder, **kwargs):
        self.domains = [d for d in domains if d][:2]
        self.website = website
        self.words, self.joined = company_words, company_joined
        self.contact_domain = contact_domain
        self.role_words = [w for w in re.findall(r"[a-z]{3,}", (role or "").lower())
                           if w not in {"intern", "internship", "the", "and", "for"}]
        self.recorder = recorder
        super().__init__(name="company_checks",
                         tools=[self.check_domain_age, self.check_website, self.check_careers_page], **kwargs)

    def check_domain_age(self, domain: str) -> str:
        """
        Look up when the company's domain was registered (RDAP).

        Args:
            domain (str): one of the company domains you were given.
        Returns:
            str: JSON with the result.
        """
        self.recorder.count_call()
        domain = (domain or "").lower().strip().removeprefix("www.")
        if domain not in self.domains:
            return json.dumps({"error": f"only these domains can be checked: {', '.join(self.domains) or 'none'}"})
        signals, check = lookups.domain_age_checks(domain)
        self.recorder.add_check(signals, check)
        return json.dumps({"check": check["name"], "status": check["status"], "detail": check["detail"]})

    def check_website(self, domain: str = "") -> str:
        """
        Open the company website and check it loads, isn't a parked page, and mentions the company.

        Args:
            domain (str): optional; the company website is always the one checked.
        Returns:
            str: JSON with the result.
        """
        self.recorder.count_call()
        if not self.website:
            return json.dumps({"error": "no company website is known"})
        signals, check = lookups.website_checks(self.website, self.words, self.joined, self.contact_domain)
        self.recorder.add_check(signals, check)
        return json.dumps({"check": check["name"], "status": check["status"], "detail": check["detail"]})

    def check_careers_page(self, domain: str = "") -> str:
        """
        Find the company website's careers or jobs page and check whether it mentions this role.

        Args:
            domain (str): optional; the company website is always the one checked.
        Returns:
            str: JSON with the result.
        """
        self.recorder.count_call()
        signals, check = careers_page_check(self.website, self.role_words)
        self.recorder.add_check(signals, check)
        return json.dumps({"check": check["name"], "status": check["status"], "detail": check["detail"]})


def careers_page_check(website, role_words):
    """Return (signals, check). A missing careers page is neutral: many genuine small firms don't have one."""
    name = "Careers page"
    if not website:
        return [], {"name": name, "status": "skipped", "detail": "no company website to look at"}
    base = website if re.match(r"^[a-z]+://", website, re.IGNORECASE) else f"https://{website}"
    try:
        home = lookups.safe_fetch(base)
    except lookups.FetchError as e:
        return [], {"name": name, "status": "unavailable", "detail": e.message}
    host = urlsplit(home["url"]).hostname or ""
    link = None
    for href, label in CAREERS_LINK.findall(home["text"] or ""):
        target = urljoin(home["url"], href)
        if urlsplit(target).hostname == host and any(w in f"{href} {label}".lower() for w in CAREERS_WORDS):
            link = target
            break
    page = None
    candidates = [link] if link else [urljoin(home["url"], p) for p in COMMON_CAREERS_PATHS]
    for candidate in candidates:
        try:
            fetched = lookups.safe_fetch(candidate)
        except lookups.FetchError:
            continue
        if fetched["status"] < 400 and urlsplit(fetched["url"]).hostname == host:
            page, link = fetched, candidate
            break
    if page is None:
        return [], {"name": name, "status": "ok", "detail": "no careers page found on the website (common for small firms)"}
    text = (trafilatura.extract(page["text"] or "") or "").lower()
    if not role_words:
        return [], {"name": name, "status": "ok", "detail": f"found {link}"}
    if sum(w in text for w in role_words) >= max(1, len(role_words) // 2 + 1) and "intern" in text:
        signal = lookups.make_signal("careers_lists_role", "positive", "medium", "Careers page lists this role",
                                     f"The company's careers page ({urlsplit(link).path or '/'}) mentions this internship role.",
                                     evidence=link, source="careers page")
        signal["sources"] = [{"title": "Careers page", "url": link}]
        return [signal], {"name": name, "status": "ok", "detail": f"found {link}, and it mentions this role"}
    return [], {"name": name, "status": "ok", "detail": f"found {link}, but it doesn't mention this role"}
