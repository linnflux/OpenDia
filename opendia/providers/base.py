from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)


@dataclass
class LLMResult:
    output: dict
    provider: str
    model: str
    usage: dict = field(default_factory=dict)

    def as_record(self) -> dict:
        # Plain dict so DBOS can checkpoint it; replays return this record instead of calling the model.
        return {"output": self.output, "provider": self.provider, "model": self.model,
                "usage": self.usage}


class Provider(Protocol):
    name: str
    model: str

    def complete_json(self, *, system: str, content: str, schema: type[T]) -> LLMResult: ...


def parse_json_object(text: str, schema: type[T]) -> dict:
    """Validate model text against the schema. Tolerates markdown fences; nothing else."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rsplit("```", 1)[0]
    try:
        return schema.model_validate(json.loads(t)).model_dump()
    except (json.JSONDecodeError, ValidationError) as e:
        raise ValueError(f"Model output did not match {schema.__name__}: {e}") from e


def schema_instructions(schema: type[BaseModel]) -> str:
    return ("Respond with a single JSON object and nothing else. It must validate against this "
            f"JSON Schema:\n{json.dumps(schema.model_json_schema())}")
