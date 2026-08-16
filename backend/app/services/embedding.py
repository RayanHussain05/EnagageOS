from __future__ import annotations

import time
from typing import Iterable, List

import google.generativeai as genai

from app.core.config import Settings


class EmbeddingError(RuntimeError):
    pass


def _configure(settings: Settings) -> None:
    genai.configure(api_key=settings.GEMINI_API_KEY)


def _model_name(settings: Settings) -> str:
    model = settings.GEMINI_EMBEDDING_MODEL
    if model.startswith("models/"):
        return model
    return f"models/{model}"


def embed_texts(settings: Settings, texts: Iterable[str], task_type: str) -> List[List[float]]:
    _configure(settings)
    model = _model_name(settings)
    vectors: List[List[float]] = []
    for text in texts:
        if not text:
            raise EmbeddingError("Empty text cannot be embedded")
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                result = genai.embed_content(
                    model=model,
                    content=text,
                    task_type=task_type,
                    output_dimensionality=settings.GEMINI_EMBEDDING_DIM,
                )
                embedding = result.get("embedding") or result.get("embedding_values")
                if embedding is None:
                    raise EmbeddingError("Gemini embedding response missing vector")
                if len(embedding) != settings.GEMINI_EMBEDDING_DIM:
                    raise EmbeddingError(
                        f"Embedding dimension mismatch: expected {settings.GEMINI_EMBEDDING_DIM}, got {len(embedding)}"
                    )
                vectors.append(embedding)
                last_error = None
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
        if last_error is not None:
            raise EmbeddingError("Gemini embedding failed") from last_error
    return vectors
