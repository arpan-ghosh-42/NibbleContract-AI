"""Shared test helpers. Nothing in the test suite touches the network."""

import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("GROQ_API_KEY", "test-key")   # app.py builds a client at import time


class FakeClient:
    """Stands in for the OpenAI-compatible Groq client: every call returns the same JSON body."""

    def __init__(self, body):
        self.body = body
        self.calls = 0
        self.chat = self
        self.completions = self

    def create(self, **kwargs):
        self.calls += 1
        message = type("Message", (), {"content": json.dumps(self.body)})
        return type("Response", (), {"choices": [type("Choice", (), {"message": message})]})


def signal(sid, polarity="negative", weight="medium", counted=True, source="test"):
    return {"id": sid, "polarity": polarity, "weight": weight, "label": sid, "explanation": "", "evidence": "",
            "evidence_verified": True, "counted": counted, "source": source}


@pytest.fixture
def fake_client():
    return FakeClient


@pytest.fixture(autouse=True)
def login_off_by_default(monkeypatch):
    """app.py loads .env; tests start with login off and turn it on explicitly (tests/test_auth.py)."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)


@pytest.fixture(autouse=True)
def clear_caches():
    from agents import orchestrator
    orchestrator._cache.clear()
    yield
    orchestrator._cache.clear()
