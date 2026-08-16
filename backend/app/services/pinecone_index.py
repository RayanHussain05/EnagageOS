from __future__ import annotations

from functools import lru_cache
from typing import Any, Dict, Iterable, List

from pinecone import Pinecone

from app.core.config import Settings
from app.services.chunking import TextChunk


@lru_cache
def _get_index(api_key: str, host: str):
    client = Pinecone(api_key=api_key)
    return client.Index(host=host)


def upsert_chunks(settings: Settings, chunks: Iterable[TextChunk], vectors: List[List[float]]) -> int:
    index = _get_index(settings.PINECONE_API_KEY, settings.PINECONE_HOST)
    batch: List[Any] = []
    total = 0
    for chunk, vector in zip(chunks, vectors, strict=False):
        metadata: Dict[str, Any] = {
            "lecture_id": chunk.lecture_id,
            "source_id": chunk.source_id,
            "page": chunk.page,
            "chunk_id": chunk.chunk_id,
            "text": chunk.text,
        }
        if chunk.course_id:
            metadata["course_id"] = chunk.course_id
        batch.append((chunk.chunk_id, vector, metadata))
        if len(batch) >= 100:
            index.upsert(vectors=batch)
            total += len(batch)
            batch = []
    if batch:
        index.upsert(vectors=batch)
        total += len(batch)
    return total


def query_index(
    settings: Settings,
    query_vector: List[float],
    lecture_id: str,
    top_k: int = 6,
) -> Any:
    index = _get_index(settings.PINECONE_API_KEY, settings.PINECONE_HOST)
    return index.query(
        vector=query_vector,
        top_k=top_k,
        include_metadata=True,
        filter={"lecture_id": lecture_id},
    )


def query_index_filtered(
    settings: Settings,
    query_vector: List[float],
    filter: Dict[str, Any],
    top_k: int = 6,
) -> Any:
    index = _get_index(settings.PINECONE_API_KEY, settings.PINECONE_HOST)
    return index.query(
        vector=query_vector,
        top_k=top_k,
        include_metadata=True,
        filter=filter,
    )
