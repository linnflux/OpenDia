"""Any OpenAI-compatible chat completions endpoint: OpenAI, Ollama, vLLM, LM Studio, OpenRouter."""

from __future__ import annotations

import os

import httpx

from .base import LLMResult, parse_json_object, schema_instructions


class OpenAICompatProvider:
    name = "openai"

    def __init__(self, conf: dict):
        self.model = conf.get("model") or "gpt-4o-mini"
        self.base_url = conf.get("base_url", "https://api.openai.com/v1").rstrip("/")
        key_env = conf.get("api_key_env", "OPENAI_API_KEY")
        self.api_key = os.environ.get(key_env, "")
        if not self.api_key and "api.openai.com" in self.base_url:
            raise RuntimeError(f"Set {key_env} to an OpenAI API key.")
        self.timeout = float(conf.get("timeout_seconds", 120))
        self.retries = int(conf.get("json_retries", 1))

    def complete_json(self, *, system, content, schema):
        messages = [{"role": "system", "content": f"{system}\n\n{schema_instructions(schema)}"},
                    {"role": "user", "content": content}]
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        usage = {"input_tokens": 0, "output_tokens": 0}
        for attempt in range(self.retries + 1):
            r = httpx.post(f"{self.base_url}/chat/completions", headers=headers, timeout=self.timeout,
                           json={"model": self.model, "messages": messages, "temperature": 0,
                                 "response_format": {"type": "json_object"}})
            r.raise_for_status()
            data = r.json()
            u = data.get("usage") or {}
            usage["input_tokens"] += u.get("prompt_tokens", 0)
            usage["output_tokens"] += u.get("completion_tokens", 0)
            text = data["choices"][0]["message"]["content"]
            try:
                return LLMResult(parse_json_object(text, schema), self.name, self.model, usage)
            except ValueError as e:
                if attempt == self.retries:
                    raise
                messages += [{"role": "assistant", "content": text},
                             {"role": "user", "content": f"That was invalid: {e}. Reply with corrected JSON only."}]
