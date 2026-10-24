"""The job-post flow: quote grounding, internship type, links and blocked sites."""

import pytest

import decoder
import job_post
import lookups

POST = ("Data Entry Intern at Zentrivo Skills Academy. Stipend Rs 30,000 per month for just 2 hours daily, no skills needed. "
        "Complete our 2-week training program first (fee Rs 2,999, fully refundable). Join our WhatsApp group to start.")


def analyst_reply(signals=(), label="paid_internship", quotes=("Stipend Rs 30,000 per month",), is_post=True):
    return {"is_job_post": is_post, "company_in_post": "Zentrivo Skills Academy", "role": "Data Entry Intern",
            "internship_type": {"label": label, "quotes": list(quotes)},
            "signals": [{"id": i, "evidence_quote": q, "explanation": "x"} for i, q in signals],
            "questions_to_ask": ["Is there any fee?"]}


def check(fake_client, reply, **kwargs):
    return job_post.check_post(fake_client(reply), "m", text=kwargs.pop("text", POST), live_lookups=False, **kwargs)


def by_id(result, sid):
    return next(s for s in result["signals"] if s["id"] == sid)


def test_quotes_not_in_the_post_are_shown_but_not_counted(fake_client):
    result = check(fake_client, analyst_reply([("asks_payment", "fee Rs 2,999, fully refundable"),
                                               ("urgency_pressure", "apply in the next 24 hours")]))
    assert by_id(result, "asks_payment")["counted"] is True
    assert by_id(result, "urgency_pressure")["counted"] is False


def test_fee_request_caps_the_report_at_25(fake_client):
    result = check(fake_client, analyst_reply([("asks_payment", "fee Rs 2,999, fully refundable"),
                                               ("clear_stipend", "Stipend Rs 30,000 per month")]))
    assert result["score"] <= 25 and result["risk_level"] == "high"


def test_verified_training_label_adds_one_strong_warning(fake_client):
    result = check(fake_client, analyst_reply(label="training_or_paid_course",
                                              quotes=["Complete our 2-week training program first"]))
    assert result["internship_type"]["label"] == "training_or_paid_course"
    assert result["internship_type"]["verified"] is True
    assert [s["id"] for s in result["signals"]].count("training_first") == 1
    assert by_id(result, "training_first")["weight"] == "high"


def test_training_label_is_not_doubled_when_the_analyst_already_flagged_it(fake_client):
    result = check(fake_client, analyst_reply([("training_first", "Complete our 2-week training program first")],
                                              label="training_or_paid_course",
                                              quotes=["Complete our 2-week training program first"]))
    assert [s["id"] for s in result["signals"]].count("training_first") == 1


def test_unverified_internship_type_is_shown_but_not_used(fake_client):
    result = check(fake_client, analyst_reply(label="training_or_paid_course", quotes=["a line that is not in the post"]))
    assert result["internship_type"]["verified"] is False
    assert not any(s["id"] == "training_first" for s in result["signals"])


def test_unknown_internship_type_becomes_unclear(fake_client):
    result = check(fake_client, analyst_reply(label="something_else", quotes=[]))
    assert result["internship_type"]["label"] == "unclear"


def test_text_that_is_not_a_job_post_is_refused(fake_client):
    with pytest.raises(decoder.DecodeError) as err:
        check(fake_client, analyst_reply(is_post=False))
    assert "doesn't look like an internship or job post" in err.value.message


@pytest.mark.parametrize("link", [
    "https://www.linkedin.com/jobs/view/4012345678",
    "lnkd.in/abc123",
    "https://www.naukri.com/job-listings-intern-xyz",
    "in.indeed.com/viewjob?jk=1",
])
def test_linkedin_and_naukri_links_get_the_paste_message_without_fetching(fake_client, monkeypatch, link):
    def no_fetch(*args, **kwargs):
        raise AssertionError("blocked sites must not be fetched")
    monkeypatch.setattr(lookups, "safe_fetch", no_fetch)
    with pytest.raises(decoder.DecodeError) as err:
        job_post.check_post(fake_client(analyst_reply()), "m", url=link, live_lookups=False)
    assert err.value.message == job_post.NO_FETCH_MESSAGE
    assert err.value.status == 422


def test_redirect_to_a_blocked_site_also_gets_the_paste_message(fake_client, monkeypatch):
    monkeypatch.setattr(lookups, "safe_fetch", lambda *a, **k: {
        "url": "https://www.linkedin.com/authwall", "status": 200, "text": "<html>login</html>"})
    with pytest.raises(decoder.DecodeError) as err:
        job_post.fetch_post_text("https://short.example/job")
    assert err.value.message == job_post.NO_FETCH_MESSAGE


def test_a_page_with_too_little_text_asks_for_the_text(monkeypatch):
    monkeypatch.setattr(lookups, "safe_fetch", lambda *a, **k: {
        "url": "https://company.example/careers", "status": 200, "text": "<html><body>Loading...</body></html>"})
    with pytest.raises(decoder.DecodeError) as err:
        job_post.fetch_post_text("https://company.example/careers")
    assert err.value.message == job_post.UNREADABLE_MESSAGE


def test_bare_short_links_are_flagged(fake_client):
    result = check(fake_client, analyst_reply(), text=POST + " Register at bit.ly/zentrivo-join today.")
    assert by_id(result, "shortened_links")["weight"] == "medium"
