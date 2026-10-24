# NibbleContract AI

> Check the internship before you apply, and the offer before you sign.

Paste or upload (PDF/.txt) an internship offer letter and get a 0 to 100 trust score with the evidence behind it, plus a plain-language review of the terms.

## What you get

- Overall risk badge (low / medium / high) and a 2-3 sentence summary
- Red flags sorted by severity, each with the exact quoted clause, what it means, and why it matters
- Deadlines and money (every amount, fee, date, and notice period)
- Questions to ask before you sign, with copy buttons

## Internship authenticity check

Every report includes a **trust score from 0 to 100** with a risk level (*Low*, *Medium* or *High risk*, for example "High risk: 3 warning signs found"). The report shows evidence and never labels a company a scam. You can optionally enter the sender email, company name and official website to sharpen the check.

How the score works (see `authenticity.py`):

- The AI model only **finds evidence** in the text for a fixed list of signals. Warning signs: asks for money, asks for sensitive details, urgency pressure, WhatsApp/Telegram-only contact, guaranteed job, unrealistic pay, held documents, no interview, no named contact, sloppy writing. Good signs: named contact, company address, clear role, explicit "no fees", a real selection process.
- Every quoted piece of evidence is verified against your document. Evidence that can't be found is shown but **not counted**.
- Sender checks are plain code, not AI: free email providers (Gmail etc.), email domain vs. company website or name, and shortened links.
- The score is fixed rules: start at 50, add up to 25 for good signs, subtract for warning signs (high 20, medium 10, low 5). Any confirmed high-severity warning caps the score at 35, and the score never goes above 85, because a document alone can't prove a company exists.
- **Live online checks** (`lookups.py`), using only the company's domain name, never the document:
  - **Domain age** through RDAP, the modern WHOIS. Under 90 days old is a strong warning, under a year is a warning, and 2+ years counts in its favour. For `.com`, `.org` and other generic domains, a missing registration record means the domain doesn't exist, which is a strong warning.
  - **Website check:** does the site load, does it mention the company, is it a parked or "for sale" page, and does it list the same email domain the offer came from.
  - The report lists everything that was checked, including lookups that couldn't run (some country domains don't publish registration data).
  - Website fetching is locked down against SSRF: only public internet hosts, ports 80/443, every redirect re-checked, and size and time limits.
  - **Web & Reddit review search** (`reviews.py`, optional, needs `TAVILY_API_KEY`): two searches per company (about 2 Tavily credits, cached for 6 hours). The AI only labels each result: about this company or not, and scam report, impersonation warning, complaint, positive, or neutral. The report shows the real search snippets with links.
    - "Scammers impersonate this company" warnings are **not** held against the company. They only count when the offer didn't come from the company's verified domain.
    - Finding nothing is reported as "no public discussion", which is not evidence either way. Many genuine small firms have no online footprint.
  - Set `LIVE_LOOKUPS=0` in `.env` to turn all online checks off.
- You also get a **"Verify it yourself" checklist** tailored to what was found.

> This is an estimate from the offer's text and the details you enter. It cannot confirm that a company or recruiter is real. Always verify through the company's official website.

## Look and feel

- The product name and tagline live in one place, `BRAND` and `TAGLINE` in `app.py`. Change them there and every page, title and report updates.
- Warm off-white by default with a single orange accent, plus a warm dark mode (sun/moon button in the header). All colors are CSS variables at the top of `static/css/style.css`.
- Fonts: Fraunces for headings, Instrument Sans for body text (Google Fonts).
- Animations are kept small (the landing page demo, the trust-score ring, fade-ins) and switch off when your OS asks for reduced motion.

## Run it

```bash
python -m venv venv
.\venv\Scripts\Activate.ps1        # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt    # flask openai python-dotenv pypdf
copy .env.example .env             # then put your Groq key in .env
python app.py
```

Open http://127.0.0.1:5001 for the landing page, or go straight to the tool at http://127.0.0.1:5001/app.

No document handy? The tool has **fictional example** buttons (an offer with obvious warning signs and a polished offer from a made-up company), and the landing page links to them directly: `/app?example=scam`, `/app?example=fake`.

## How it works

- `POST /decode` takes a multipart form with either `text` or a `file`, plus optional `sender_email`, `company_name` and `website`.
- `decoder.py` extracts PDF text (pypdf), rejects files over 5 MB / 80 pages / 60,000 characters, and handles scanned PDFs with a friendly message.
- The Groq model acts as a skeptical reviewer and must return JSON. Output is repaired and retried once if invalid. Long documents are chunked and merged.
- Every quoted clause is checked against the source text; quotes that can't be found are marked as unverified.
- Documents are processed in memory only, never written to disk or logged. Saved reports (in your browser's localStorage) contain the report, not the document.

> **Not legal advice.** Have someone you trust review anything important before you sign.

## Project structure

```text
decoder/
├── app.py            # Flask routes
├── decoder.py        # extraction, prompts, JSON repair, quote verification
├── authenticity.py   # internship trust score: signals, sender checks, scoring
├── lookups.py        # RDAP domain age + safe website check
├── reviews.py        # web + Reddit reputation search (Tavily)
├── templates/landing.html   # marketing / landing page (/)
├── templates/app.html       # the decoder tool (/app)
├── static/css/style.css     # tool + report styles
├── static/css/landing.css   # landing page styles
├── static/js/app.js         # tool logic and report rendering
├── static/js/landing.js     # landing animations and score demo
├── static/js/samples.js     # fictional example documents
├── requirements.txt
└── .env              # local API key (not committed)
```
