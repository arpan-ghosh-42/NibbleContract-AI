from flask import Flask, Request, render_template, request, jsonify
from openai import OpenAI, RateLimitError
from dotenv import load_dotenv
import io
import os

import auth
import authenticity
import decoder
import job_post

load_dotenv()


class InMemoryUploadRequest(Request):
    """Keep uploaded files in memory instead of Werkzeug's on-disk temp files.

    Uploads are capped by MAX_CONTENT_LENGTH, so this is bounded, and it means
    documents never touch the disk.
    """

    def _get_file_stream(self, total_content_length, content_type, filename=None, content_length=None):
        return io.BytesIO()


app = Flask(__name__)
app.request_class = InMemoryUploadRequest
app.config["MAX_CONTENT_LENGTH"] = decoder.MAX_UPLOAD_BYTES + 1024 * 1024
app.config["MAX_FORM_MEMORY_SIZE"] = 1024 * 1024
#.\venv\Scripts\python.exe app.py

MODEL = (os.getenv("GROQ_MODEL") or "openai/gpt-oss-120b").strip()

# Domain-age (RDAP) and website checks for internship offers. Set LIVE_LOOKUPS=0 to disable.
LIVE_LOOKUPS = os.getenv("LIVE_LOOKUPS", "1") != "0"
# Optional: web + Reddit review search for internship offers (only the company name is sent).
TAVILY_API_KEY = (os.getenv("TAVILY_API_KEY") or "").strip()

groq_client = OpenAI(
    api_key=os.getenv("GROQ_API_KEY"),
    base_url="https://api.groq.com/openai/v1"
)


# One place to rename the product. Templates read these through the context processor.
BRAND = ("NibbleContract", "AI")
# Bump when templates/terms.html changes: sign-ups record which version they agreed to.
TERMS_VERSION = "2026-10-25"
TERMS_UPDATED = "25 October 2026"
TAGLINE = "Check the internship before you apply, and the offer before you sign."


@app.context_processor
def inject_brand():
    # The Supabase URL and publishable key are public by design; the secret key never reaches the browser.
    supabase_url, supabase_key = auth.settings()
    return {"brand_a": BRAND[0], "brand_b": BRAND[1], "tagline": TAGLINE,
            "supabase_url": supabase_url, "supabase_key": supabase_key, "auth_enabled": auth.enabled(),
            "terms_version": TERMS_VERSION, "terms_updated": TERMS_UPDATED}


@app.route("/")
def home():
    return render_template("landing.html")


@app.route("/app")
def tool():
    return render_template("app.html")


@app.route("/login")
def login():
    return render_template("login.html")


@app.route("/terms")
def terms():
    return render_template("terms.html")


@app.route("/status")
def status():
    return jsonify({"ok": True})


@app.errorhandler(413)
def request_too_large(error):
    return jsonify({
        "error": "That upload is too large. Files must be under 5 MB."
    }), 413


@app.route("/check-post", methods=["POST"])
@auth.login_required
def check_post():
    # Never log or persist the post itself; only sizes and outcomes.
    try:
        result = job_post.check_post(
            groq_client, MODEL,
            text=request.form.get("text", ""),
            url=request.form.get("url", ""),
            company_name=request.form.get("company_name", ""),
            website=request.form.get("website", ""),
            live_lookups=LIVE_LOOKUPS,
            tavily_key=TAVILY_API_KEY,
        )
    except decoder.DecodeError as e:
        return jsonify({"error": e.message}), e.status
    except RateLimitError:
        return jsonify({
            "error": "The AI service is rate-limiting us right now. Wait a minute and try again."
        }), 429
    except Exception as e:
        app.logger.warning("check-post failed: %s", type(e).__name__)
        return jsonify({
            "error": "Something went wrong while checking the post. Please try again."
        }), 502

    app.logger.info(
        "check-post ok: source=%s chars=%d signals=%d score=%d",
        result["meta"]["source"], result["meta"]["characters"], len(result["signals"]), result["score"],
    )
    return jsonify({"type": "job_post", "result": result})


@app.route("/decode", methods=["POST"])
@auth.login_required
def decode():
    # Never log or persist document contents; only sizes and outcomes.
    # The product only reviews internship offers now; any other doc_type from old clients is ignored.
    doc_type = "internship_offer"
    upload = request.files.get("file")

    try:
        if upload and upload.filename:
            data = upload.read(decoder.MAX_UPLOAD_BYTES + 1)
            text, source = decoder.extract_upload(upload.filename, data)
        else:
            text, source = request.form.get("text", ""), "paste"

        report = decoder.decode_document(groq_client, MODEL, doc_type, text)

        try:
            report["authenticity"] = authenticity.assess(
                groq_client, MODEL, text,
                sender_email=request.form.get("sender_email", ""),
                company_name=request.form.get("company_name", ""),
                website=request.form.get("website", ""),
                live_lookups=LIVE_LOOKUPS,
                tavily_key=TAVILY_API_KEY,
            )
        except RateLimitError:
            raise
        except Exception as e:
            # The offer review is still useful without the trust score.
            app.logger.warning("authenticity failed: %s", type(e).__name__)
            report["authenticity"] = None
            report["authenticity_error"] = "The trust score couldn't be calculated this time. The offer review below is still valid."

    except decoder.DecodeError as e:
        return jsonify({"error": e.message}), e.status

    except RateLimitError:
        return jsonify({
            "error": "The AI service is rate-limiting us right now. Wait a minute and try again."
        }), 429

    except Exception as e:
        app.logger.warning("decode failed: %s", type(e).__name__)
        return jsonify({
            "error": "Something went wrong while reviewing the document. Please try again."
        }), 502

    report["meta"]["source"] = source
    if source != "paste":
        report["meta"]["filename"] = os.path.basename(upload.filename)[:120]

    app.logger.info(
        "decode ok: type=%s source=%s chars=%d chunks=%d flags=%d unverified=%d",
        doc_type, source, report["meta"]["characters"], report["meta"]["chunks"],
        len(report["red_flags"]), report["meta"]["unverified_quotes"],
    )

    return jsonify({"type": "decoder", "result": report})


if __name__ == "__main__":
    app.run(debug=True, port=5001)
