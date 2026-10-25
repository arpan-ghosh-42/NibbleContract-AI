"""
Login check for the API (Supabase Auth).

The browser logs in with supabase-js and sends its access token as
`Authorization: Bearer <token>`. Here we ask Supabase who that token belongs
to (GET /auth/v1/user) and cache the answer for a few minutes, so a check
costs at most one quick lookup. No secret key is needed: the publishable key
plus the user's own token is enough.

Auth is on when SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set. Without
them (local development) every request is allowed and a warning is logged once.
"""

import functools
import hashlib
import json
import logging
import os
import socket
import threading
import time
import urllib.error
import urllib.request

from flask import g, jsonify, request

TIMEOUT = 6
CACHE_SECONDS = 300
MAX_CACHE = 2000

log = logging.getLogger(__name__)
_cache = {}
_lock = threading.Lock()
_warned = False


def settings():
    url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.getenv("SUPABASE_PUBLISHABLE_KEY") or "").strip()
    return url, key


def enabled():
    url, key = settings()
    return bool(url and key)


def fetch_user(token):
    """Return the Supabase user for a valid access token, or None. Raises on network problems."""
    url, key = settings()
    req = urllib.request.Request(f"{url}/auth/v1/user", headers={
        "apikey": key, "Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read(200_000).decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403, 404):
            return None
        raise
    return data if isinstance(data, dict) and data.get("id") else None


def user_for(token, lookup=None):
    """Cached token -> user lookup. Only a hash of the token is kept in memory."""
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.time()
    with _lock:
        hit = _cache.get(digest)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    user = (lookup or fetch_user)(token)
    if user:
        with _lock:
            if len(_cache) >= MAX_CACHE:
                _cache.clear()
            _cache[digest] = (now, user)
    return user


def login_required(view):
    """Reject API calls without a valid Supabase login (when auth is configured)."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        global _warned
        if not enabled():
            if not _warned:
                log.warning("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set: the API is open (fine for local development)")
                _warned = True
            g.user = None
            return view(*args, **kwargs)

        header = request.headers.get("Authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if not token:
            return jsonify({"error": "Please log in to run a check.", "login": True}), 401
        try:
            user = user_for(token)
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError, ValueError):
            return jsonify({"error": "We couldn't confirm your login right now. Please try again."}), 503
        if not user:
            return jsonify({"error": "Your login has expired. Please log in again.", "login": True}), 401
        g.user = {"id": user["id"], "email": user.get("email", "")}
        return view(*args, **kwargs)
    return wrapper
