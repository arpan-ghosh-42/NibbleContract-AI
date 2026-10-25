"""Login protection for the API (auth.py), with Supabase stubbed out."""

import urllib.error

import pytest

import app as app_module
import auth

POST = "Backend intern at Acme. Stipend Rs 20,000 per month for six months. Build APIs with the platform team."
REPLY = {"is_job_post": True, "company_in_post": "Acme", "role": "Intern",
         "internship_type": {"label": "paid_internship", "quotes": ["Stipend Rs 20,000 per month"]},
         "signals": [], "questions_to_ask": []}


@pytest.fixture
def client(monkeypatch, fake_client):
    monkeypatch.setattr(app_module, "groq_client", fake_client(REPLY))
    monkeypatch.setattr(app_module, "LIVE_LOOKUPS", False)
    auth._cache.clear()
    return app_module.app.test_client()


@pytest.fixture
def login_on(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    users = {"good-token": {"id": "user-1", "email": "student@college.edu"}}
    calls = []

    def fake_fetch(token):
        calls.append(token)
        return users.get(token)
    monkeypatch.setattr(auth, "fetch_user", fake_fetch)
    return calls


def check(client, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post("/check-post", data={"text": POST}, headers=headers)


def test_without_supabase_settings_the_api_stays_open(client):
    assert check(client).status_code == 200


def test_a_check_without_a_login_is_refused(client, login_on):
    response = check(client)
    assert response.status_code == 401 and response.get_json()["login"] is True
    assert login_on == []                       # no lookup without a token


def test_an_invalid_or_expired_token_is_refused(client, login_on):
    response = check(client, "stolen-or-expired")
    assert response.status_code == 401 and response.get_json()["login"] is True


def test_a_valid_login_can_run_checks(client, login_on):
    response = check(client, "good-token")
    assert response.status_code == 200
    assert "score" in response.get_json()["result"]


def test_offer_letters_are_protected_too(client, login_on):
    assert client.post("/decode", data={"text": POST}).status_code == 401


def test_logins_are_cached_and_only_a_hash_of_the_token_is_kept(client, login_on):
    check(client, "good-token")
    check(client, "good-token")
    assert login_on == ["good-token"]           # one lookup for two checks
    assert all("good-token" not in key for key in auth._cache)


def test_when_supabase_is_unreachable_the_check_says_so(client, login_on, monkeypatch):
    def down(token):
        raise urllib.error.URLError("no route")
    monkeypatch.setattr(auth, "fetch_user", down)
    assert check(client, "good-token").status_code == 503


def test_the_login_page_gets_only_the_public_supabase_settings(client, login_on):
    page = client.get("/login").get_data(as_text=True)
    assert "https://example.supabase.co" in page and "sb_publishable_test" in page
    assert "supabase-js@2.117.3" in page


def test_the_tool_page_hides_until_the_login_check(client, login_on):
    assert 'class="app-page auth-pending"' in client.get("/app").get_data(as_text=True)


def test_landing_and_status_stay_public(client, login_on):
    assert client.get("/").status_code == 200 and client.get("/status").status_code == 200
