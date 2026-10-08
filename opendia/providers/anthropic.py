"""Anthropic Claude via the official SDK.

Authentication is the user's own API key, or Amazon Bedrock / Google Vertex credentials.
OpenDia never reads, stores, or forwards Claude.ai subscription logins or session tokens:
Anthropic's terms do not allow third-party apps to use them.
"""

from __future__ import annotations

import os

from .base import LLMResult


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, conf: dict):
        try:
            import anthropic
        except ImportError as e:
            raise RuntimeError("Install the extra: pip install 'opendia[anthropic]'") from e
        self.model = conf.get("model") or "claude-haiku-4-5-20251001"
        self.max_tokens = int(conf.get("max_tokens", 1024))
        platform = conf.get("platform", "api")
        if platform == "bedrock":
            self.client = anthropic.AnthropicBedrock()
        elif platform == "vertex":
            self.client = anthropic.AnthropicVertex()
        else:
            key_env = conf.get("api_key_env", "ANTHROPIC_API_KEY")
            key = os.environ.get(key_env)
            if not key:
                raise RuntimeError(f"Set {key_env} to an Anthropic API key (console.anthropic.com).")
            self.client = anthropic.Anthropic(api_key=key)

    def complete_json(self, *, system, content, schema):
        # Forced tool use gives schema-shaped JSON without parsing free text.
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            messages=[{"role": "user", "content": content}],
            tools=[{"name": "respond", "description": f"Return the {schema.__name__}.",
                    "input_schema": schema.model_json_schema()}],
            tool_choice={"type": "tool", "name": "respond"},
        )
        block = next(b for b in resp.content if b.type == "tool_use")
        out = schema.model_validate(block.input).model_dump()
        usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
        return LLMResult(out, self.name, self.model, usage)
