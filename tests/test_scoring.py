"""Scoring rules for job posts (job_signals.py)."""

import job_signals
from conftest import signal

ALL_GOOD = [signal(sid, "positive", "medium") for sid in
            ("clear_stipend", "specific_tasks", "selection_process", "no_fees_stated", "careers_lists_role")]


def test_payment_request_caps_score_at_25_whatever_the_good_signs():
    signals = job_signals.adjust_signals(ALL_GOOD + [signal("asks_payment", weight="high")])
    value, risk = job_signals.score(signals, research_done=True)
    assert value <= job_signals.PAYMENT_CAP == 25
    assert risk == "high"


def test_any_other_high_warning_caps_at_35():
    value, _ = job_signals.score(ALL_GOOD + [signal("chat_only_onboarding", weight="high")], research_done=True)
    assert value == 35


def test_text_only_score_is_capped_at_85_and_research_at_90():
    assert job_signals.score(ALL_GOOD, research_done=False)[0] == 85
    assert job_signals.score(ALL_GOOD, research_done=True)[0] == 90


def test_funding_is_bonus_only_and_never_cancels_a_fee_request():
    funding = signal("funding_recent", "positive", "medium")
    with_fee = job_signals.score([funding, signal("asks_payment", weight="high")], research_done=True)[0]
    assert with_fee <= 25
    assert job_signals.score([funding], research_done=True)[0] > job_signals.BASE_SCORE


def test_no_reviews_and_no_funding_is_neutral():
    # Finding nothing online produces no signals, so the score is exactly what the post alone gives.
    post = [signal("clear_stipend", "positive", "medium")]
    assert job_signals.score(post, research_done=False)[0] == job_signals.BASE_SCORE + 10


def test_impersonation_warnings_are_shown_but_never_counted():
    adjusted = job_signals.adjust_signals([signal("impersonation_warnings", weight="low")])
    assert adjusted[0]["counted"] is False
    assert adjusted[0]["not_counted_reason"]
    assert job_signals.score(adjusted, research_done=True)[0] == job_signals.BASE_SCORE


def test_contradictions_are_removed():
    adjusted = job_signals.adjust_signals([
        signal("asks_payment", weight="high"), signal("no_fees_stated", "positive"),
        signal("unrealistic_stipend", weight="high"), signal("clear_stipend", "positive"),
    ])
    ids = {s["id"] for s in adjusted}
    assert "no_fees_stated" not in ids and "clear_stipend" not in ids


def test_uncounted_signals_do_not_change_the_score():
    value, _ = job_signals.score([signal("asks_payment", weight="high", counted=False)], research_done=False)
    assert value == job_signals.BASE_SCORE


def test_weight_overrides_apply_to_shared_online_signals():
    adjusted = job_signals.adjust_signals([signal("website_missing", weight="medium")])
    assert adjusted[0]["weight"] == "high"


def test_risk_label_never_calls_anyone_a_scam():
    label = job_signals.risk_label("high", [signal("asks_payment", weight="high"), signal("vague_role")])
    assert label == "High risk: 2 warning signs found"
    assert "scam" not in label.lower()
