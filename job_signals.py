"""
Job-post trust score: the signal catalogue and the scoring rules, in one place
so they are easy to tune.

Models and research only *find evidence* for these signals. Everything that
turns evidence into a number lives here as plain code, so the score is
explainable and a model can't talk itself into a flattering result.
"""

BASE_SCORE = 50
WEIGHTS = {"high": 20, "medium": 10, "low": 5}
MAX_POSITIVE_BONUS = 40
HIGH_NEGATIVE_CAP = 35        # any counted high-severity warning caps the score
PAYMENT_CAP = 25              # a confirmed payment request caps it lower, whatever the good signs
MAX_SCORE_TEXT_ONLY = 85      # a post alone can't prove the company is real
MAX_SCORE_WITH_RESEARCH = 90

RISK_LABELS = {"low": "Low risk", "medium": "Medium risk", "high": "High risk"}

# Signals the post analyst looks for in the text.
# id -> (polarity, weight, needs_quote, label, what the model should look for)
POST_CATALOG = {
    "asks_payment": ("negative", "high", True, "Asks applicants to pay",
                     "any fee, deposit, 'registration', 'refundable amount', paid certificate or LOR, "
                     "or a laptop/kit the applicant must buy"),
    "training_first": ("negative", "high", True, "Training or course first, internship later",
                       "the applicant must first complete or buy a training, course or bootcamp before the "
                       "(paid) internship starts"),
    "chat_only_onboarding": ("negative", "high", True, "Onboarding only through chat groups or mass calls",
                             "selection or onboarding only via a WhatsApp/Telegram group or a mass Google Meet, "
                             "with no resume, test or interview"),
    "unrealistic_stipend": ("negative", "high", True, "Stipend looks unrealistic for the work",
                            "pay clearly out of line with the work, e.g. very high stipend for data entry, typing, "
                            "liking posts, or 'no skills needed'"),
    "training_provider": ("negative", "medium", True, "Training provider advertising an 'internship'",
                          "the company presents itself as an e-learning, training, edtech or mentoring provider "
                          "while advertising an internship"),
    "guaranteed_placement": ("negative", "medium", True, "Guarantees a job or placement",
                             "guaranteed job, placement, PPO or certificate regardless of performance"),
    "urgency_pressure": ("negative", "medium", True, "Pressure to apply quickly",
                         "'limited seats', 'apply within 24 hours', countdowns or threats that the chance will be lost"),
    "vague_role": ("negative", "medium", False, "Role is vague",
                   "no concrete tasks, tools, team or deliverables are described"),
    "no_named_contact": ("negative", "low", False, "No named contact or recruiter",
                         "no named recruiter, HR person or team contact anywhere in the post"),
    "poor_writing": ("negative", "low", True, "Sloppy or copy-paste writing",
                     "many spelling/grammar errors, leftover template text, or mismatched company names"),
    "clear_stipend": ("positive", "medium", True, "Clear stipend, duration and hours",
                      "a specific stipend amount (e.g. Rs 15,000/month) together with the duration and hours"),
    "specific_tasks": ("positive", "medium", True, "Specific tasks, tools and team",
                       "concrete responsibilities, named tools or tech, and the team the intern joins"),
    "selection_process": ("positive", "medium", True, "Real selection process",
                          "an assignment, test, technical interview or several interview rounds"),
    "no_fees_stated": ("positive", "medium", True, "Says there are no fees",
                       "explicitly states the applicant pays nothing at any stage"),
}

INTERNSHIP_TYPES = {
    "paid_internship": "Paid internship",
    "unpaid_internship": "Unpaid internship",
    "training_or_paid_course": "Training or paid course sold as an internship",
    "agency_or_recruiter_post": "Posted by an agency or recruiter",
    "unclear": "Unclear",
}

# Signals from the shared online checks (lookups.py, reviews.py) re-weighted for job posts.
WEIGHT_OVERRIDES = {
    "website_missing": "high",        # the domain or website does not exist
    "shortened_links": "medium",
    "public_complaints": "medium",
    "public_positive": "medium",
    "domain_established": "low",      # domain age is not company age
}

# Funding news only counts from established news sites, and only as a bonus.
RECENT_FUNDING_YEARS = 3
CREDIBLE_NEWS_DOMAINS = {
    "techcrunch.com", "inc42.com", "yourstory.com", "entrackr.com", "vccircle.com", "indiatimes.com",
    "livemint.com", "moneycontrol.com", "business-standard.com", "thehindubusinessline.com",
    "financialexpress.com", "businesstoday.in", "thehindu.com", "hindustantimes.com", "ndtvprofit.com",
    "the-ken.com", "themorningcontext.com", "medianama.com", "reuters.com", "bloomberg.com", "forbes.com",
    "venturebeat.com", "sifted.eu", "techinasia.com", "businessinsider.com", "cnbc.com",
}

PAYMENT_SIGNALS = {"asks_payment"}
# Warnings about scammers using a company's name say nothing about the company itself.
NEVER_COUNTED = {"impersonation_warnings"}
# When the first signal is counted, the second one makes no sense alongside it.
CONTRADICTIONS = [
    ("asks_payment", "no_fees_stated"),
    ("training_first", "no_fees_stated"),
    ("unrealistic_stipend", "clear_stipend"),   # a clearly stated stipend that's too good to be true earns nothing
    ("specific_tasks", "vague_role"),
]


def adjust_signals(signals):
    """Apply weight overrides, never-counted rules and contradictions. Returns a new list."""
    out = []
    for s in signals:
        s = dict(s)
        if s["id"] in WEIGHT_OVERRIDES:
            s["weight"] = WEIGHT_OVERRIDES[s["id"]]
        if s["id"] in NEVER_COUNTED:
            s["counted"] = False
            s["not_counted_reason"] = "Warnings about fake offers using a company's name aren't held against the company."
        out.append(s)
    counted = {s["id"] for s in out if s["counted"]}
    drop = {loser for winner, loser in CONTRADICTIONS if winner in counted}
    return [s for s in out if s["id"] not in drop]


def score(signals, research_done):
    """Return (score, risk_level). Only counted signals change the score."""
    counted = [s for s in signals if s["counted"]]
    negative = sum(WEIGHTS[s["weight"]] for s in counted if s["polarity"] == "negative")
    positive = min(MAX_POSITIVE_BONUS, sum(WEIGHTS[s["weight"]] for s in counted if s["polarity"] == "positive"))
    value = BASE_SCORE + positive - negative

    if any(s["polarity"] == "negative" and s["weight"] == "high" for s in counted):
        value = min(value, HIGH_NEGATIVE_CAP)
    if any(s["id"] in PAYMENT_SIGNALS for s in counted):
        value = min(value, PAYMENT_CAP)
    value = max(0, min(MAX_SCORE_WITH_RESEARCH if research_done else MAX_SCORE_TEXT_ONLY, value))

    if value >= 70:
        return value, "low"
    if value >= 40:
        return value, "medium"
    return value, "high"


def risk_label(risk_level, signals):
    """e.g. "High risk: 3 warning signs found"."""
    warnings = sum(1 for s in signals if s["counted"] and s["polarity"] == "negative")
    label = RISK_LABELS[risk_level]
    if warnings:
        label += f": {warnings} warning sign{'s' if warnings != 1 else ''} found"
    return label


def confidence(signals, research_done):
    """How much evidence the score rests on: low / medium / high."""
    counted = sum(1 for s in signals if s["counted"])
    if research_done and counted >= 4:
        return "high"
    if research_done or counted >= 3:
        return "medium"
    return "low"
