"""Only internship material gets checked (relevance.py)."""

import pytest

import app as app_module
import decoder
import job_post
import relevance

BLOOD_REPORT = ("COMPLETE BLOOD COUNT (CBC)\nPatient: R. Sharma   Age/Sex: 21/M   Sample collected: 12-10-2026\n"
                "Haemoglobin 14.2 g/dL (13.0-17.0)\nRBC count 4.9 million/uL (4.5-5.5)\nWBC count 7,800 /uL (4,000-11,000)\n"
                "Platelet count 2.4 lakh/uL (1.5-4.1)\nESR 12 mm/hr\nInterpretation: values within normal limits.\n"
                "Pathologist: Dr. A. Mehta, MD (Path)")
OFFER = ("Dear Meera, we are pleased to offer you the position of Data Analyst Intern at Brightwave Analytics. "
         "Your stipend will be Rs 20,000 per month and your joining date is 1 December 2026.")


def test_a_blood_report_is_refused_without_any_ai_call(fake_client):
    client = fake_client({"is_offer_letter": True})
    with pytest.raises(decoder.DecodeError) as err:
        relevance.require_offer_letter(client, "m", BLOOD_REPORT)
    assert err.value.status == 422 and "valid internship offer letter" in err.value.message
    assert client.calls == 0


def test_hiring_words_alone_are_not_enough_the_ai_must_confirm(fake_client):
    client = fake_client({"is_offer_letter": False, "document_type": "employment law article"})
    with pytest.raises(decoder.DecodeError) as err:
        relevance.require_offer_letter(client, "m", "An article about employment law, salary rules and hiring interns.")
    assert err.value.message.startswith("This looks like an employment law article, not an internship offer letter")


def test_odd_model_labels_are_not_shown_to_the_user(fake_client):
    client = fake_client({"is_offer_letter": False, "document_type": "<script>alert(1)</script>"})
    with pytest.raises(decoder.DecodeError) as err:
        relevance.require_offer_letter(client, "m", OFFER)
    assert err.value.message == relevance.NOT_AN_OFFER_MESSAGE


def test_a_real_offer_letter_passes(fake_client):
    relevance.require_offer_letter(fake_client({"is_offer_letter": True, "document_type": "internship offer letter"}), "m", OFFER)


def test_offer_route_refuses_a_blood_report_before_reviewing_it(monkeypatch, fake_client):
    monkeypatch.setattr(app_module, "groq_client", fake_client({}))
    monkeypatch.setattr(decoder, "decode_document", lambda *a, **k: pytest.fail("must not be reviewed"))
    response = app_module.app.test_client().post("/decode", data={"text": BLOOD_REPORT})
    assert response.status_code == 422
    assert "valid internship offer letter" in response.get_json()["error"]


def test_job_post_tab_refuses_a_blood_report_without_any_ai_call(fake_client):
    client = fake_client({})
    with pytest.raises(decoder.DecodeError) as err:
        job_post.check_post(client, "m", text=BLOOD_REPORT, live_lookups=False)
    assert err.value.message == relevance.NOT_A_POST_MESSAGE and client.calls == 0
