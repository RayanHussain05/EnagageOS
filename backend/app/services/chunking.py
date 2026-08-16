from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional


@dataclass
class TextChunk:
    chunk_id: str
    text: str
    page: int
    lecture_id: str
    source_id: str
    course_id: Optional[str]


def _chunk_words(words: List[str], target_words: int, overlap: int) -> Iterable[List[str]]:
    if not words:
        return
    start = 0
    total = len(words)
    while start < total:
        end = min(start + target_words, total)
        yield words[start:end]
        if end >= total:
            break
        start = max(0, end - overlap)


def chunk_pages(
    pages: Iterable[tuple[int, str]],
    lecture_id: str,
    source_id: str,
    course_id: Optional[str] = None,
    target_words: int = 250,
    overlap: int = 50,
) -> List[TextChunk]:
    chunks: List[TextChunk] = []
    for page_num, page_text in pages:
        words = page_text.split()
        if not words:
            continue
        for idx, word_chunk in enumerate(_chunk_words(words, target_words, overlap)):
            chunk_text = " ".join(word_chunk).strip()
            if not chunk_text:
                continue
            chunk_id = f"{lecture_id}:{page_num}:{idx}"
            chunks.append(
                TextChunk(
                    chunk_id=chunk_id,
                    text=chunk_text,
                    page=page_num,
                    lecture_id=lecture_id,
                    source_id=source_id,
                    course_id=course_id,
                )
            )
    return chunks
