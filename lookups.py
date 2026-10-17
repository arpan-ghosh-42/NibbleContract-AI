"""
Live lookups for the internship authenticity check:

  1. Domain age / registration via RDAP (the modern, machine-readable WHOIS).
  2. Does the company website exist, and does it actually match the company?

Only domain names are sent to third parties. The document itself never leaves
this server except to the AI model.

Fetching a URL that a user typed is a classic SSRF hole, so safe_fetch() is
strict: http/https only, ports 80/443 only, every hostname must resolve to
public IPs, every redirect hop is re-validated, the connection is pinned to the
IP that was validated (no DNS re-resolution), and size and time are capped.
"""

import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape
from urllib.parse import urljoin, urlsplit

USER_AGENT = "NibbleContractAI/1.0 (+authenticity check)"
FETCH_TIMEOUT = 6
RDAP_TIMEOUT = 8
MAX_BYTES = 300_000
MAX_REDIRECTS = 3
ALLOWED_PORTS = {80, 443}
CACHE_SECONDS = 6 * 3600

NEW_DOMAIN_DAYS = 90
YOUNG_DOMAIN_DAYS = 365
ESTABLISHED_DAYS = 730
LONG_ESTABLISHED_DAYS = 1825

PARKED_PHRASES = re.compile(
    r"(this domain (is|may be) for sale|domain (is )?for sale|buy this domain|parked (free|domain)|"
    r"parked by|coming soon|under construction|website (is )?under (construction|maintenance)|"
    r"default web ?site page|welcome to nginx|it works!|apache2 (ubuntu )?default page|"
    r"this site can.t be reached|hugedomains|sedo\.com|godaddy\.com/domains)",
    re.IGNORECASE,
)
# Generic TLDs where publishing RDAP is mandatory (ICANN), so a 404 means "not registered".
RDAP_MANDATORY_TLDS = {"com", "net", "org", "info", "biz", "xyz", "online", "site", "app", "dev", "tech",
                       "store", "shop", "top", "club", "live", "work", "careers", "jobs", "company", "solutions"}
_DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

_cache = {}


class FetchError(Exception):
    """kind: blocked | dns | timeout | connect | tls | http | other"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def make_signal(sid, polarity, weight, label, explanation, evidence="", verified=True, source="", counted=True):
    return {
        "id": sid, "polarity": polarity, "weight": weight, "label": label, "explanation": explanation,
        "evidence": evidence, "evidence_verified": verified, "counted": counted, "source": source,
    }


# -----------------------------
# SAFE FETCH
# -----------------------------

def _ip_allowed(ip):
    """Only globally routable addresses. Blocks loopback, private, link-local, metadata, etc."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def resolve_public(host, port):
    """Resolve host and return one validated IP string, or raise FetchError."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise FetchError("dns", f"{host} does not resolve")
    except UnicodeError:
        raise FetchError("blocked", "invalid hostname")
    ips = []
    for info in infos:
        try:
            ips.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not ips:
        raise FetchError("dns", f"{host} does not resolve")
    if not all(_ip_allowed(ip) for ip in ips):
        raise FetchError("blocked", "that address is not a public internet host")
    return str(ips[0])


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._pin = ip

    def connect(self):
        self.sock = socket.create_connection((self._pin, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, ip, timeout, context):
        super().__init__(host, port, timeout=timeout, context=context)
        self._pin = ip

    def connect(self):
        sock = socket.create_connection((self._pin, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def safe_fetch(url, timeout=FETCH_TIMEOUT, max_bytes=MAX_BYTES, max_redirects=MAX_REDIRECTS):
    """GET a page safely. Returns {"url", "status", "text"}; raises FetchError."""
    context = ssl.create_default_context()
    current = url
    for _hop in range(max_redirects + 1):
        parts = urlsplit(current)
        if parts.scheme not in ("http", "https"):
            raise FetchError("blocked", "only http and https links are allowed")
        if not parts.hostname or parts.username or parts.password:
            raise FetchError("blocked", "invalid link")
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:
            raise FetchError("blocked", "invalid port")
        if port not in ALLOWED_PORTS:
            raise FetchError("blocked", "unusual port")

        ip = resolve_public(parts.hostname, port)
        if parts.scheme == "https":
            conn = _PinnedHTTPSConnection(parts.hostname, port, ip, timeout, context)
        else:
            conn = _PinnedHTTPConnection(parts.hostname, port, ip, timeout)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        try:
            conn.request("GET", path, headers={
                "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
                "Accept-Encoding": "identity", "Connection": "close"})
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308) and resp.getheader("Location"):
                current = urljoin(current, resp.getheader("Location"))
                continue
            body = resp.read(max_bytes)
            ctype = (resp.getheader("Content-Type") or "").lower()
            text = ""
            if "html" in ctype or "xml" in ctype or not ctype:
                charset = re.search(r"charset=([\w\-]+)", ctype)
                try:
                    text = body.decode(charset.group(1) if charset else "utf-8", errors="replace")
                except LookupError:
                    text = body.decode("utf-8", errors="replace")
            return {"url": current, "status": resp.status, "text": text}
        except ssl.SSLCertVerificationError:
            raise FetchError("tls", "the website's security certificate is invalid")
        except ssl.SSLError:
            raise FetchError("tls", "secure connection failed")
        except (socket.timeout, TimeoutError):
            raise FetchError("timeout", "the website took too long to respond")
        except (ConnectionError, OSError, http.client.HTTPException):
            raise FetchError("connect", "could not connect to the website")
        finally:
            conn.close()
    raise FetchError("other", "too many redirects")


# -----------------------------
# RDAP (DOMAIN AGE)
# -----------------------------

class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise urllib.error.URLError("refusing non-https redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _cached(key, producer):
    entry = _cache.get(key)
    if entry and time.time() - entry[0] < CACHE_SECONDS:
        return entry[1]
    value = producer()
    _cache[key] = (time.time(), value)
    return value


def rdap_registration(domain):
    """Return {"registered": datetime|None, "expires": datetime|None} or raise FetchError."""
    domain = (domain or "").lower().strip(".")
    if not _DOMAIN_RE.match(domain):
        raise FetchError("other", "not a valid domain name")

    def fetch():
        opener = urllib.request.build_opener(_HttpsOnlyRedirect)
        req = urllib.request.Request(f"https://rdap.org/domain/{domain}",
                                     headers={"Accept": "application/rdap+json", "User-Agent": USER_AGENT})
        try:
            with opener.open(req, timeout=RDAP_TIMEOUT) as resp:
                data = json.loads(resp.read(1_000_000).decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FetchError("not_found", "no public registration record found")
            raise FetchError("http", f"the registration lookup service returned {e.code}")
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError):
            raise FetchError("connect", "the registration lookup service could not be reached")
        except ValueError:
            raise FetchError("other", "unreadable registration data")

        out = {"registered": None, "expires": None}
        for event in data.get("events", []) if isinstance(data, dict) else []:
            when = _parse_date(event.get("eventDate"))
            if event.get("eventAction") == "registration" and when:
                out["registered"] = when
            elif event.get("eventAction") == "expiration" and when:
                out["expires"] = when
        return out

    return _cached(("rdap", domain), fetch)


def _parse_date(value):
    try:
        when = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def _age_text(days):
    if days < 60:
        return f"{days} days"
    if days < 700:
        return f"{round(days / 30.4)} months"
    return f"{days / 365.25:.1f} years"


def domain_age_checks(domain):
    """Return (signals, check) for one domain."""
    name = f"Domain registration: {domain}"
    try:
        info = rdap_registration(domain)
    except FetchError as e:
        tld = domain.rsplit(".", 1)[-1]
        if e.kind == "not_found" and tld in RDAP_MANDATORY_TLDS:
            # These registries must publish RDAP, so no record means the domain isn't registered.
            return ([make_signal("domain_unregistered", "negative", "high", "Company domain isn't registered",
                                 f"{domain} has no registration record, so it isn't a real registered domain. "
                                 "A genuine company's email and website domain always exists.",
                                 evidence=domain, source="RDAP lookup")],
                    {"name": name, "status": "warn", "detail": "not registered"})
        if e.kind == "not_found":
            return [], {"name": name, "status": "unavailable",
                        "detail": "no public registration record (some country domains don't publish one)"}
        return [], {"name": name, "status": "unavailable", "detail": e.message}

    registered = info["registered"]
    if not registered:
        return [], {"name": name, "status": "unavailable", "detail": "the record has no registration date"}

    days = max(0, (datetime.now(timezone.utc) - registered).days)
    date = registered.date().isoformat()
    age = _age_text(days)
    caveat = " Domain age isn't company age, but scam sites are often brand new."
    signals = []
    status = "ok"
    if days < NEW_DOMAIN_DAYS:
        signals.append(make_signal("domain_very_new", "negative", "high", "Company website domain is brand new",
                                   f"{domain} was registered only {age} ago.{caveat}",
                                   evidence=f"registered {date}", source="RDAP lookup"))
        status = "warn"
    elif days < YOUNG_DOMAIN_DAYS:
        signals.append(make_signal("domain_young", "negative", "medium", "Company website domain is under a year old",
                                   f"{domain} was registered {age} ago.{caveat}",
                                   evidence=f"registered {date}", source="RDAP lookup"))
        status = "warn"
    elif days >= LONG_ESTABLISHED_DAYS:
        signals.append(make_signal("domain_established", "positive", "medium", "Long-established domain",
                                   f"{domain} has been registered for {age}.",
                                   evidence=f"registered {date}", source="RDAP lookup"))
    elif days >= ESTABLISHED_DAYS:
        signals.append(make_signal("domain_established", "positive", "low", "Domain registered for over two years",
                                   f"{domain} has been registered for {age}.",
                                   evidence=f"registered {date}", source="RDAP lookup"))
    return signals, {"name": name, "status": status, "detail": f"registered {date} ({age} ago)"}


# -----------------------------
# WEBSITE CHECK
# -----------------------------

def _alnum(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def page_summary(html):
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.IGNORECASE | re.DOTALL)
    title = re.sub(r"\s+", " ", unescape(title_match.group(1))).strip() if title_match else ""
    body = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html or "")
    body = re.sub(r"(?s)<!--.*?-->", " ", body)
    body = re.sub(r"<[^>]+>", " ", body)
    text = re.sub(r"\s+", " ", unescape(body)).strip()
    return title[:200], text[:60_000]


def mentions_company(title, text, words, joined):
    haystack = _alnum(f"{title} {text}")
    if joined and joined in haystack:
        return True
    long_words = [w for w in words if len(w) >= 4]
    return bool(long_words) and all(w in haystack for w in long_words)


def website_checks(target, company_words, company_joined, sender_domain):
    """Return (signals, check) for the company website."""
    url = target if re.match(r"^[a-z]+://", target, re.IGNORECASE) else f"https://{target}"
    host = urlsplit(url).hostname or target
    name = f"Website: {host}"
    try:
        try:
            page = safe_fetch(url)
        except FetchError as first:
            if first.kind != "connect" or urlsplit(url).scheme != "https":
                raise
            page = safe_fetch("http://" + url.split("://", 1)[1])
    except FetchError as e:
        if e.kind == "dns":
            return ([make_signal("website_missing", "negative", "medium", "Company website does not exist",
                                 f"{host} doesn't resolve to any server, so the website you were given isn't reachable.",
                                 evidence=host, source="website check")],
                    {"name": name, "status": "warn", "detail": e.message})
        return [], {"name": name, "status": "unavailable", "detail": e.message}

    final_host = urlsplit(page["url"]).hostname or host
    title, text = page_summary(page["text"])
    signals = []
    status = "ok"
    detail = f"loaded (HTTP {page['status']})" + (f", title: \"{title}\"" if title else "")
    if final_host != host:
        detail += f", redirected to {final_host}"

    if page["status"] >= 400:
        return [], {"name": name, "status": "unavailable", "detail": f"the site answered with an error (HTTP {page['status']})"}

    if PARKED_PHRASES.search(f"{title} {text[:3000]}"):
        signals.append(make_signal("website_parked", "negative", "medium", "Website looks parked or unfinished",
                                   f"{final_host} shows a placeholder, 'for sale' or 'coming soon' page instead of a real company site.",
                                   evidence=(title or text[:80]), source="website check"))
        return signals, {"name": name, "status": "warn", "detail": detail + ", looks like a placeholder page"}

    if len(text) < 300:
        return signals, {"name": name, "status": "unavailable",
                         "detail": detail + ", but there is too little readable text to judge (the site may need JavaScript)"}

    if company_joined:
        if mentions_company(title, text, company_words, company_joined):
            signals.append(make_signal("website_matches", "positive", "medium", "Website mentions the company",
                                       f"{final_host} is a real, working site that mentions the company name.",
                                       evidence=title or final_host, source="website check"))
        else:
            signals.append(make_signal("website_mismatch", "negative", "medium", "Website doesn't mention the company",
                                       f"{final_host} loads, but its text never mentions '{' '.join(company_words)}'. "
                                       "It may belong to a different business.",
                                       evidence=title or final_host, source="website check"))
            status = "warn"

    if sender_domain and sender_domain in text.lower():
        signals.append(make_signal("website_lists_contact", "positive", "low", "Website lists the same contact domain",
                                   f"The site's pages mention {sender_domain}, the same domain the offer email came from.",
                                   evidence=sender_domain, source="website check"))
    return signals, {"name": name, "status": status, "detail": detail}


# -----------------------------
# ENTRY POINT
# -----------------------------

def run_checks(domains, website_target, company_words, company_joined, sender_domain):
    """
    domains: non-free registered domains to look up in RDAP (max 2)
    website_target: URL or domain to fetch, or ""
    Returns (signals, checks). Never raises.
    """
    jobs = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for domain in domains[:2]:
            jobs.append(pool.submit(domain_age_checks, domain))
        if website_target:
            jobs.append(pool.submit(website_checks, website_target, company_words, company_joined, sender_domain))
        signals, checks = [], []
        for job in jobs:
            try:
                sigs, check = job.result(timeout=30)
            except Exception:
                continue
            signals.extend(sigs)
            checks.append(check)

    # An unregistered domain already explains why its website is missing; don't penalise it twice.
    if any(s["id"] == "domain_unregistered" for s in signals):
        signals = [s for s in signals if s["id"] != "website_missing"]

    if not checks:
        checks.append({"name": "Online lookups", "status": "skipped",
                       "detail": "Add the company website or a company email address to check domain age and the website."})
    return signals, checks
