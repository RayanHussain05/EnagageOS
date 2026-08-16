from __future__ import annotations

from app.core.config import Settings
from app.models.schemas import IngestRequest
from app.services.chunking import chunk_pages
from app.services.embedding import embed_texts
from app.services.extract import extract_text_from_pdf
from app.services.pinecone_index import upsert_chunks
from app.services.r2_client import download_object
from app.services.text_normalize import normalize_text


class IngestPipelineError(RuntimeError):
    pass


def run_ingest(settings: Settings, req: IngestRequest) -> int:
    data = download_object(settings, req.file_key)
    pages = extract_text_from_pdf(data)
    if not pages:
        raise IngestPipelineError("No pages extracted from PDF")

    normalized_pages = []
    for page_num, text in pages:
        clean = normalize_text(text)
        if clean:
            normalized_pages.append((page_num, clean))

    if not normalized_pages:
        raise IngestPipelineError("No text extracted from PDF")

    chunks = chunk_pages(
        normalized_pages,
        lecture_id=req.lecture_id,
        source_id=req.file_key,
        course_id=req.course_id,
    )

    if not chunks:
        raise IngestPipelineError("No chunks created")

    embeddings = embed_texts(
        settings,
        [chunk.text for chunk in chunks],
        task_type="retrieval_document",
    )

    return upsert_chunks(settings, chunks, embeddings)
