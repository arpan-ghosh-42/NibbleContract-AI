"""Structured output every research agent returns (Agno output_schema)."""

from typing import Optional

from pydantic import BaseModel, Field


class Finding(BaseModel):
    claim: str = Field(description="One short plain sentence: what this source says about the company.")
    # The parser model only sees the agent's answer and this schema, so the allowed labels live here.
    stance: str = Field(description=(
        "Reputation research: scam_report, impersonation_warning, complaint, positive or neutral. "
        "Funding research: funding_round (the company raised money) or not_funding. "
        "Company checks: supports, concern or neutral."))
    source_url: str = Field(description="The exact URL of the search result this claim comes from, copied from a tool result.")
    snippet: str = Field(default="", description="A short excerpt from that search result.")
    date: Optional[str] = Field(default=None, description="Date or year of the event if the source states one, else null.")
    about_company: bool = Field(default=True, description="False if the result is about a different company or is generic.")


class AgentOutput(BaseModel):
    findings: list[Finding] = Field(default_factory=list)
    summary: str = Field(default="", description="One or two plain sentences on what you found.")
