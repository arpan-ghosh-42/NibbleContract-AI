"""HTTP routes, with the model and research stubbed out."""

import pytest

import app as app_module
import job_post


@pytest.fixture
def client():
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def test_check_post_returns_the_paste_message_for_linkedin(client):
    response = client.post("/check-post", data={"url": "https://www.linkedin.com/jobs/view/1"})
    assert response.status_code == 422
    assert response.get_json()["error"] == job_post.NO_FETCH_MESSAGE


def test_check_post_needs_text_or_a_link(client):
    response = client.post("/check-post", data={"text": "too short"})
    assert response.status_code == 400


def test_check_post_returns_the_report_shape(client, monkeypatch, fake_client):
    reply = {"is_job_post": True, "company_in_post": "Acme", "role": "Intern",
             "internship_type": {"label": "paid_internship", "quotes": ["Stipend Rs 20,000 per month"]},
             "signals": [{"id": "clear_stipend", "evidence_quote": "Stipend Rs 20,000 per month", "explanation": "x"}],
             "questions_to_ask": []}
    monkeypatch.setattr(app_module, "groq_client", fake_client(reply))
    monkeypatch.setattr(app_module, "LIVE_LOOKUPS", False)
    text = "Backend intern at Acme. Stipend Rs 20,000 per month for six months. Build APIs with the platform team."
    response = client.post("/check-post", data={"text": text})
    assert response.status_code == 200
    result = response.get_json()["result"]
    for key in ("score", "risk_level", "internship_type", "signals", "agents", "checklist", "limits"):
        assert key in result
    assert result["internship_type"]["label"] == "paid_internship"


def test_status(client):
    assert client.get("/status").get_json() == {"ok": True}
