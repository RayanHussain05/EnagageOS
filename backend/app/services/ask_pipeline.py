from __future__ import annotations

from typing import Any, Dict, List
import logging
import re

from app.core.config import Settings
from app.models.schemas import AskRequest, AskResponse, Citation, TopChunk
from app.services.embedding import embed_texts
from app.services.chunking import chunk_pages
from app.services.text_normalize import normalize_text
from pathlib import Path
from app.services.pinecone_index import query_index, query_index_filtered
from app.services.rag import generate_answer, generate_best_effort, generate_summary


logger = logging.getLogger(__name__)


class AskPipelineError(RuntimeError):
    pass


def _average(scores: List[float]) -> float:
    if not scores:
        return 0.0
    return sum(scores) / len(scores)


_SUMMARY_PATTERN = re.compile(
    r"\b(summary|summarize|overview|recap|tldr|tl;dr|catch up|key points|main points|big picture|high[- ]level|gist|outline)\b",
    re.IGNORECASE,
)


def _is_summary_question(question: str) -> bool:
    if not question:
        return False
    return bool(_SUMMARY_PATTERN.search(question))


def _looks_like_bullets(text: str) -> bool:
    if not text:
        return False
    if "•" in text:
        return True
    bullet_lines = [line for line in text.splitlines() if line.strip().startswith(("-", "*", "•"))]
    if len(bullet_lines) >= 2:
        return True
    if text.count(" - ") >= 3:
        return True
    return False


def _strip_question_prefix(answer: str, question: str) -> str:
    if not answer or not question:
        return answer
    q = question.strip().rstrip("?").lower()
    a = answer.strip()
    if a.lower().startswith(q):
        trimmed = a[len(a.split("?")[0]) + 1 :].strip() if "?" in a else a[len(q) :].strip()
        return trimmed if trimmed else answer
    return answer


def _normalize_bullets(answer: str) -> str:
    if not answer:
        return answer
    if "•" not in answer and " - " not in answer and "*" not in answer:
        return answer
    parts = [p.strip() for p in re.split(r"[•\*]", answer) if p.strip()]
    if not parts:
        return answer
    if parts[0].endswith("?"):
        parts = parts[1:]
    parts = [p[:-1].strip() if p.endswith(":") else p for p in parts]
    if not parts:
        return answer
    sentences: List[str] = []
    first = parts[0]
    if not first.endswith((".", "!", "?")):
        first = first.rstrip(".") + "."
    sentences.append(first)
    for seg in parts[1:]:
        if not seg:
            continue
        seg = seg.rstrip(".")
        if seg.lower().startswith(("can ", "controls ", "stores ", "captures ", "converts ", "connects ")):
            seg = "It " + seg
        sentences.append(seg + ".")
    return " ".join(sentences).strip()


def _to_matches(result: Any) -> List[Any]:
    return result.get("matches") if isinstance(result, dict) else result.matches


def _load_demo_context(settings: Settings) -> str | None:
    if not getattr(settings, "DEMO_CONTEXT_ENABLED", False):
        return None
    path_str = getattr(settings, "DEMO_CONTEXT_FILE", "") or ""
    if not path_str:
        return None
    path = Path(path_str)
    if not path.is_absolute():
        path = Path.cwd() / path_str
    try:
        if not path.exists():
            logger.warning("Demo context file not found: %s", path)
            return None
        raw = path.read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed reading demo context: %s", exc)
        return None
    cleaned = normalize_text(raw)
    return cleaned if cleaned else None


def run_ask(settings: Settings, req: AskRequest) -> AskResponse:
    summary_mode = _is_summary_question(req.question)
    logger.info(
        "RAG config summary=%s chat_model=%s fallbacks=%s safety=%s",
        summary_mode,
        getattr(settings, "GEMINI_CHAT_MODEL", ""),
        getattr(settings, "GEMINI_FALLBACK_MODELS", ""),
        getattr(settings, "GEMINI_SAFETY", ""),
    )
    demo_context = _load_demo_context(settings)
    override_text = normalize_text(req.context_override) if req.context_override else None
    manual_context = None
    if demo_context and override_text:
        manual_context = f"{demo_context}\n\n{override_text}"
    else:
        manual_context = demo_context or override_text
    if manual_context:
        override_chunks = chunk_pages(
            [(1, manual_context)],
            lecture_id=req.lecture_id,
            source_id="manual-context",
            course_id=req.course_id,
        )
        chunks = [
            {
                "chunk_id": chunk.chunk_id,
                "text": chunk.text,
                "page": chunk.page,
                "lecture_id": chunk.lecture_id,
                "source_id": chunk.source_id,
                "course_id": chunk.course_id,
            }
            for chunk in override_chunks
        ]
        top_chunks = [
            TopChunk(chunk_id=chunk["chunk_id"], score=1.0) for chunk in chunks[:6]
        ]

        try:
            rag_result = (
                generate_summary(settings, chunks, req.question)
                if summary_mode
                else generate_answer(settings, chunks, req.question)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Demo-context generation failed: %s", exc, exc_info=True)
            best = generate_best_effort(settings, chunks, req.question, summary=summary_mode)
            answer = (
                f"I don't know based on the lecture materials. {best}"
                if best
                else "I don't know based on the lecture materials."
            )
            return AskResponse(
                answer=answer,
                confidence=0.0,
                citations=[],
                top_chunks=top_chunks,
            )

        citations = []
        for meta in chunks[:3]:
            citations.append(
                Citation(
                    source_id=meta.get("source_id", ""),
                    page=meta.get("page"),
                    chunk_id=meta.get("chunk_id"),
                )
            )

        answer = rag_result.get("answer") or "I don't know based on the lecture materials."
        answer = _strip_question_prefix(answer, req.question)
        if _looks_like_bullets(answer):
            answer = _normalize_bullets(answer)

        if answer.strip().lower().startswith("i don't know based on the lecture materials"):
            best = generate_best_effort(settings, chunks, req.question, summary=summary_mode)
            if best:
                answer = f"I don't know based on the lecture materials. {best}"

        return AskResponse(
            answer=answer,
            confidence=float(rag_result.get("confidence", 0.9)),
            citations=citations,
            top_chunks=top_chunks,
        )
    vector = embed_texts(settings, [req.question], task_type="retrieval_query")[0]
    lecture_top_k = 30 if summary_mode else 10
    course_top_k = 20 if summary_mode else 10
    lecture_result = query_index(settings, vector, req.lecture_id, top_k=lecture_top_k)
    lecture_matches = _to_matches(lecture_result) or []

    course_matches: List[Any] = []
    if req.course_id:
        course_result = query_index_filtered(
            settings, vector, {"course_id": req.course_id}, top_k=course_top_k
        )
        course_matches = _to_matches(course_result) or []

    if not lecture_matches and not course_matches:
        best = generate_best_effort(settings, [], req.question, summary=summary_mode)
        answer = (
            f"I don't know based on the lecture materials. {best}"
            if best
            else "I don't know based on the lecture materials."
        )
        return AskResponse(
            answer=answer,
            confidence=0.0,
            citations=[],
            top_chunks=[],
        )

    def _score(match: Any) -> float:
        return float(match.get("score") if isinstance(match, dict) else match.score)

    def _meta(match: Any) -> Dict[str, Any]:
        return match.get("metadata") if isinstance(match, dict) else match.metadata or {}

    def _select_diverse_by_page(matches: List[Any], max_chunks: int) -> List[Any]:
        selected: List[Any] = []
        seen_pages: set = set()
        for match in sorted(matches, key=_score, reverse=True):
            meta = _meta(match)
            page = meta.get("page") if meta else None
            key = page if page is not None else id(match)
            if key in seen_pages:
                continue
            selected.append(match)
            seen_pages.add(key)
            if len(selected) >= max_chunks:
                break
        if len(selected) < max_chunks:
            for match in sorted(matches, key=_score, reverse=True):
                if match in selected:
                    continue
                selected.append(match)
                if len(selected) >= max_chunks:
                    break
        return selected

    max_lecture_score = max((_score(m) for m in lecture_matches), default=0.0)
    max_course_score = max((_score(m) for m in course_matches), default=0.0)

    if summary_mode:
        selected = _select_diverse_by_page(lecture_matches, max_chunks=12)
        if len(selected) < 8 and course_matches and max_course_score >= 0.55:
            def _is_same_lecture(match: Any) -> bool:
                meta = _meta(match)
                return meta and meta.get("lecture_id") == req.lecture_id

            course_only = [m for m in course_matches if not _is_same_lecture(m)]
            selected.extend(_select_diverse_by_page(course_only, max_chunks=4))
    else:
        # Prefer lecture-specific context when it is relevant enough.
        if max_lecture_score >= 0.62:
            selected = sorted(lecture_matches, key=_score, reverse=True)[:8]
        else:
            selected = sorted(lecture_matches, key=_score, reverse=True)[:5]

            if course_matches and max_course_score >= 0.6:
                def _is_same_lecture(match: Any) -> bool:
                    meta = _meta(match)
                    return meta and meta.get("lecture_id") == req.lecture_id

                course_only = [m for m in course_matches if not _is_same_lecture(m)]
                course_only_sorted = sorted(course_only, key=_score, reverse=True)
                selected.extend(course_only_sorted[:5])

    matches = sorted(selected, key=_score, reverse=True)[:10]

    chunks: List[Dict[str, Any]] = []
    top_chunks: List[TopChunk] = []
    scores: List[float] = []

    for match in matches:
        score = match.get("score") if isinstance(match, dict) else match.score
        metadata = match.get("metadata") if isinstance(match, dict) else match.metadata
        if metadata is None:
            continue
        chunks.append(metadata)
        if metadata.get("chunk_id"):
            top_chunks.append(TopChunk(chunk_id=metadata["chunk_id"], score=float(score)))
        scores.append(float(score))

    confidence = _average(scores)
    max_score = max(scores) if scores else 0.0
    min_score = 0.45 if summary_mode else 0.6

    logger.info(
        "RAG retrieve summary=%s lecture_matches=%s course_matches=%s max_lecture=%.3f max_course=%.3f max_selected=%.3f",
        summary_mode,
        len(lecture_matches),
        len(course_matches),
        max_lecture_score,
        max_course_score,
        max_score,
    )

    if max_score < min_score:
        best = generate_best_effort(settings, chunks, req.question, summary=summary_mode)
        answer = (
            f"I don't know based on the lecture materials. {best}"
            if best
            else "I don't know based on the lecture materials."
        )
        return AskResponse(
            answer=answer,
            confidence=max_score,
            citations=[],
            top_chunks=top_chunks,
        )

    try:
        rag_result = (
            generate_summary(settings, chunks, req.question)
            if summary_mode
            else generate_answer(settings, chunks, req.question)
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("RAG generation failed, falling back to top chunk: %s", exc, exc_info=True)
        # Fallback: return a simple answer with top chunk context
        top_text = chunks[0].get("text", "") if chunks else ""
        fallback_citations = []
        for meta in chunks[:3]:
            fallback_citations.append(
                Citation(
                    source_id=meta.get("source_id", ""),
                    page=meta.get("page"),
                    chunk_id=meta.get("chunk_id"),
                )
            )
        best = generate_best_effort(settings, chunks, req.question, summary=summary_mode)
        if best:
            answer = f"I don't know based on the lecture materials. {best}"
        else:
            answer = top_text or "I don't know based on the lecture materials."
        return AskResponse(
            answer=answer,
            confidence=confidence,
            citations=fallback_citations,
            top_chunks=top_chunks,
        )

    citations = []
    for cite in rag_result.get("citations", []) or []:
        chunk_id = cite.get("chunk_id")
        page = cite.get("page")
        if chunk_id:
            # source_id is kept in metadata, map by chunk_id if needed
            source_id = None
            for meta in chunks:
                if meta.get("chunk_id") == chunk_id:
                    source_id = meta.get("source_id")
                    break
            citations.append(Citation(source_id=source_id or "", page=page, chunk_id=chunk_id))

    if not citations:
        # Fallback to top chunks when model omits citations
        for meta in chunks[:3]:
            citations.append(
                Citation(
                    source_id=meta.get("source_id", ""),
                    page=meta.get("page"),
                    chunk_id=meta.get("chunk_id"),
                )
            )

    answer = rag_result.get("answer") or "I don't know based on the lecture materials."
    answer = _strip_question_prefix(answer, req.question)

    # Final safety net: normalize any bullet-ish output.
    if _looks_like_bullets(answer):
        answer = _normalize_bullets(answer)

    if answer.strip().lower().startswith("i don't know based on the lecture materials"):
        best = generate_best_effort(settings, chunks, req.question, summary=summary_mode)
        if best:
            answer = f"I don't know based on the lecture materials. {best}"

    return AskResponse(
        answer=answer,
        confidence=float(rag_result.get("confidence", confidence)),
        citations=citations,
        top_chunks=top_chunks,
    )
