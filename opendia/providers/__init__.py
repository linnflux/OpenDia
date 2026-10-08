"""Model-agnostic LLM layer. Every provider returns a validated pydantic object."""

from __future__ import annotations

from ..plugins import load_object
from .base import LLMResult, Provider


def load_provider(conf: dict) -> Provider:
    kind = conf.get("kind", "fake")
    if kind == "fake":
        from .fake import FakeProvider
        return FakeProvider(conf)
    if kind == "anthropic":
        from .anthropic import AnthropicProvider
        return AnthropicProvider(conf)
    if kind == "openai":
        from .openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(conf)
    return load_object(kind)(conf)


__all__ = ["LLMResult", "Provider", "load_provider"]
