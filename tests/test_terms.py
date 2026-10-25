"""Terms and Conditions page and the agreement step at sign-up."""

import pytest

import app as app_module


@pytest.fixture
def client():
    return app_module.app.test_client()


def test_terms_page_is_public_and_carries_the_key_clauses(client):
    response = client.get("/terms")
    page = response.get_data(as_text=True)
    assert response.status_code == 200
    assert f"Last updated: {app_module.TERMS_UPDATED}" in page
    for clause in ("public information available on the web", "not legal, financial or career advice",
                   "not responsible", "limited to zero rupees", "laws of India"):
        assert clause in page
    assert "[your city]" not in page


def test_create_account_needs_the_terms_checkbox(client):
    page = client.get("/login").get_data(as_text=True)
    assert 'id="authTerms"' in page and 'href="/terms"' in page
    assert f'window.NC_TERMS_VERSION = "{app_module.TERMS_VERSION}"' in page


def test_terms_are_linked_from_the_landing_page_and_the_tool(client):
    assert 'href="/terms"' in client.get("/").get_data(as_text=True)
    assert 'href="/terms"' in client.get("/app").get_data(as_text=True)
