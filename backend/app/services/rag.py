from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List

import google.generativeai as genai
from google.generativeai import types as genai_types

from app.core.config import Settings

logger = logging.getLogger(__name__)


class RagError(RuntimeError):
    pass


def _configure(settings: Settings) -> None:
    genai.configure(api_key=settings.GEMINI_API_KEY)


def _candidate_models(settings: Settings) -> List[str]:
    raw = getattr(settings, "GEMINI_FALLBACK_MODELS", "") or ""
    fallbacks = [model.strip() for model in raw.split(",") if model.strip()]
    primary = (settings.GEMINI_CHAT_MODEL or "").strip()
    candidates = [primary] if primary else []
    for model in fallbacks:
        if model not in candidates:
            candidates.append(model)
    return candidates


def _safety_settings(settings: Settings) -> Dict[genai_types.HarmCategory, genai_types.HarmBlockThreshold] | None:
    mode = (getattr(settings, "GEMINI_SAFETY", "") or "").strip().lower()
    if mode in ("", "default"):
        return None
    if mode not in ("block_only_high", "block_none"):
        logger.warning("Unknown GEMINI_SAFETY=%s, falling back to default", mode)
        return None
    threshold = (
        genai_types.HarmBlockThreshold.BLOCK_ONLY_HIGH
        if mode == "block_only_high"
        else genai_types.HarmBlockThreshold.BLOCK_NONE
    )
    return {
        genai_types.HarmCategory.HARM_CATEGORY_HARASSMENT: threshold,
        genai_types.HarmCategory.HARM_CATEGORY_HATE_SPEECH: threshold,
        genai_types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: threshold,
        genai_types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: threshold,
    }


def _response_text(response: Any) -> str:
    try:
        text = response.text or ""
        if text:
            return text.strip()
    except Exception:
        pass

    candidates = getattr(response, "candidates", None) or []
    for cand in candidates:
        content = getattr(cand, "content", None)
        parts = getattr(content, "parts", None) or []
        texts: List[str] = []
        for part in parts:
            part_text = getattr(part, "text", None)
            if part_text:
                texts.append(part_text)
        if texts:
            return "\n".join(texts).strip()

    raise RagError("Gemini response contained no text parts")


def _generate_content_with_fallback(
    settings: Settings,
    prompt: str,
    generation_config: Dict[str, Any],
    stage: str,
) -> tuple[str, str]:
    last_error: Exception | None = None
    for model_name in _candidate_models(settings):
        response = None
        try:
            model = genai.GenerativeModel(model_name)
            response = model.generate_content(
                prompt,
                generation_config=generation_config,
                safety_settings=_safety_settings(settings),
            )
            text = _response_text(response)
            return text, model_name
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            finish_reasons = []
            try:
                finish_reasons = [
                    getattr(c, "finish_reason", None)
                    for c in (getattr(response, "candidates", None) or [])
                ]
            except Exception:
                finish_reasons = []
            logger.warning(
                "Gemini %s failed for model=%s: %s finish_reasons=%s",
                stage,
                model_name,
                exc,
                finish_reasons,
                exc_info=True,
            )
    raise RagError(f"All Gemini models failed for {stage}") from last_error


def _generate_json_with_fallback(settings: Settings, prompt: str, stage: str) -> Dict[str, Any]:
    last_error: Exception | None = None
    configs = [
        {
            "temperature": 0.1,
            "max_output_tokens": 700,
            "response_mime_type": "application/json",
        },
        {"temperature": 0.1, "max_output_tokens": 700},
    ]
    for config in configs:
        try:
            text, _model = _generate_content_with_fallback(settings, prompt, config, stage)
            return _extract_json(text)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if isinstance(exc, RagError):
                logger.warning(
                    "Gemini %s failed to generate JSON: %s",
                    stage,
                    exc,
                    exc_info=True,
                )
            else:
                logger.warning(
                    "Gemini %s returned invalid JSON: %s",
                    stage,
                    exc,
                    exc_info=True,
                )
    raise RagError(f"Gemini JSON generation failed for {stage}") from last_error


def build_prompt(chunks: List[Dict[str, Any]], question: str) -> str:
    context_lines: List[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        text = chunk.get("text", "").strip()
        chunk_id = chunk.get("chunk_id")
        page = chunk.get("page")
        context_lines.append(
            f"SOURCE {idx}\nchunk_id: {chunk_id}\npage: {page}\ntext: {text}\n"
        )

    context = "\n".join(context_lines)
    return (
        "SYSTEM:\n"
        "You are a careful teaching assistant. Use ONLY the provided sources from lecture slides/notes. "
        "Do not add outside knowledge. If the answer is not in the sources, say "
        "\"I don't know based on the lecture materials.\" Return JSON only. You MUST include citations.\n\n"
        "STYLE:\n"
        "- Explain clearly to a student seeing the topic for the first time.\n"
        "- Use the same terms as the sources whenever possible.\n"
        "- Paraphrase: do NOT copy source sentences or bullet lists verbatim.\n"
        "- If sources are list-like, rewrite them into natural sentences.\n"
        "- Structure the answer with: 1) one-sentence summary, 2) short explanation, "
        "3) 3–5 key points on separate lines prefixed with '-' (plain text), "
        "4) a quick check-yourself question if relevant.\n"
        "- Keep it concise but helpful.\n\n"
        "CITATIONS:\n"
        "- Include citations for every major claim using chunk_id + page from the sources.\n"
        "- If multiple sources support a claim, include multiple citations.\n\n"
        "SOURCES:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "RESPONSE FORMAT (JSON only, no markdown):\n"
        "{\n"
        "  \"answer\": \"...\",\n"
        "  \"citations\": [\n"
        "    {\"chunk_id\": \"...\", \"page\": 12}\n"
        "  ],\n"
        "  \"confidence\": 0.0\n"
        "}"
    )


def _extract_json(text: str) -> Dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise RagError("No JSON object found in model output")
    payload = text[start : end + 1]
    return json.loads(payload)


def _needs_rewrite(answer: str) -> bool:
    if not answer:
        return False
    if "•" in answer:
        return True
    bullet_lines = [line for line in answer.splitlines() if line.strip().startswith(("-", "*"))]
    if len(bullet_lines) >= 3:
        return True
    if answer.count(" - ") >= 3:
        return True
    return False


def _rewrite_answer(settings: Settings, question: str, notes: str) -> str:
    _configure(settings)
    prompt = (
        "SYSTEM:\n"
        "You are a teaching assistant. Rewrite the NOTES into a clear, student-friendly explanation.\n"
        "Rules:\n"
        "- Use ONLY the notes. Do not add new facts.\n"
        "- Do NOT copy phrases verbatim from the notes.\n"
        "- Use 4–8 short sentences. No bullet points, no headings, no lists.\n"
        "- Keep it concise and helpful.\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "NOTES:\n"
        f"{notes}\n\n"
        "Rewrite:\n"
    )
    text, _model = _generate_content_with_fallback(
        settings,
        prompt,
        {"temperature": 0.2, "max_output_tokens": 350},
        "rewrite-answer",
    )
    return text


def _extract_facts(settings: Settings, chunks: List[Dict[str, Any]], question: str) -> Dict[str, Any]:
    _configure(settings)
    context_lines: List[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        text = chunk.get("text", "").strip()
        chunk_id = chunk.get("chunk_id")
        page = chunk.get("page")
        context_lines.append(
            f"SOURCE {idx}\nchunk_id: {chunk_id}\npage: {page}\ntext: {text}\n"
        )

    context = "\n".join(context_lines)
    prompt = (
        "SYSTEM:\n"
        "Extract ONLY the minimal facts needed to answer the question using the sources. "
        "Do not add outside knowledge. Return JSON only.\n\n"
        "SOURCES:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "RESPONSE FORMAT (JSON only):\n"
        "{\n"
        "  \"unknown\": false,\n"
        "  \"facts\": [\n"
        "    {\n"
        "      \"fact\": \"...\",\n"
        "      \"citations\": [\n"
        "        {\"chunk_id\": \"...\", \"page\": 12}\n"
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}\n"
    )

    return _generate_json_with_fallback(settings, prompt, "extract-facts")


def _extract_summary_facts(
    settings: Settings,
    chunks: List[Dict[str, Any]],
    question: str,
) -> Dict[str, Any]:
    _configure(settings)
    context_lines: List[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        text = chunk.get("text", "").strip()
        chunk_id = chunk.get("chunk_id")
        page = chunk.get("page")
        context_lines.append(
            f"SOURCE {idx}\nchunk_id: {chunk_id}\npage: {page}\ntext: {text}\n"
        )

    context = "\n".join(context_lines)
    prompt = (
        "SYSTEM:\n"
        "Extract 6–10 short facts that together summarize the lecture content. "
        "Focus on the main concepts, definitions, and relationships. "
        "Do not add outside knowledge. Return JSON only.\n\n"
        "SOURCES:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "RESPONSE FORMAT (JSON only):\n"
        "{\n"
        "  \"unknown\": false,\n"
        "  \"facts\": [\n"
        "    {\n"
        "      \"fact\": \"...\",\n"
        "      \"citations\": [\n"
        "        {\"chunk_id\": \"...\", \"page\": 12}\n"
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}\n"
    )

    return _generate_json_with_fallback(settings, prompt, "extract-summary-facts")


def _compose_answer(settings: Settings, question: str, facts: List[Dict[str, Any]]) -> str:
    _configure(settings)
    if not facts:
        return ""
    facts_lines: List[str] = []
    for idx, item in enumerate(facts, start=1):
        fact = item.get("fact", "").strip()
        if not fact:
            continue
        facts_lines.append(f"{idx}. {fact}")

    notes = "\n".join(facts_lines)
    prompt = (
        "SYSTEM:\n"
        "You are a teaching assistant. Use ONLY the numbered facts below. "
        "Do not add new facts. Do NOT include citations in the answer.\n"
        "Write 4–8 short sentences in plain text. No bullet points, no headings, no lists.\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "FACTS:\n"
        f"{notes}\n\n"
        "Answer:\n"
    )
    text, _model = _generate_content_with_fallback(
        settings,
        prompt,
        {"temperature": 0.2, "max_output_tokens": 350},
        "compose-answer",
    )
    return text


def _compose_summary(settings: Settings, question: str, facts: List[Dict[str, Any]]) -> str:
    _configure(settings)
    if not facts:
        return ""
    facts_lines: List[str] = []
    for idx, item in enumerate(facts, start=1):
        fact = item.get("fact", "").strip()
        if not fact:
            continue
        facts_lines.append(f"{idx}. {fact}")

    notes = "\n".join(facts_lines)
    prompt = (
        "SYSTEM:\n"
        "You are a teaching assistant. Use ONLY the numbered facts below. "
        "Do not add new facts. Do NOT include citations in the answer.\n"
        "Write 3–5 concise sentences that give a quick catch-up summary. "
        "No bullet points, no headings, no lists.\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "FACTS:\n"
        f"{notes}\n\n"
        "Summary:\n"
    )
    text, _model = _generate_content_with_fallback(
        settings,
        prompt,
        {"temperature": 0.2, "max_output_tokens": 260},
        "compose-summary",
    )
    return text


def _dedupe_citations(facts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out: List[Dict[str, Any]] = []
    for item in facts:
        for cite in item.get("citations", []) or []:
            chunk_id = cite.get("chunk_id")
            page = cite.get("page")
            key = (chunk_id, page)
            if not chunk_id or key in seen:
                continue
            seen.add(key)
            out.append({"chunk_id": chunk_id, "page": page})
    return out


def _top_chunk_citations(chunks: List[Dict[str, Any]], limit: int = 3) -> List[Dict[str, Any]]:
    citations: List[Dict[str, Any]] = []
    for meta in chunks[:limit]:
        chunk_id = meta.get("chunk_id")
        page = meta.get("page")
        if not chunk_id:
            continue
        citations.append({"chunk_id": chunk_id, "page": page})
    return citations


def _extractive_summary(chunks: List[Dict[str, Any]], max_sentences: int = 4) -> str:
    if not chunks:
        return ""
    ordered = sorted(
        chunks,
        key=lambda meta: (
            meta.get("page") if meta.get("page") is not None else 10_000,
            meta.get("chunk_id") or "",
        ),
    )
    sentences: List[str] = []
    seen = set()
    for meta in ordered:
        text = (meta.get("text") or "").strip()
        if not text:
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            candidate = sentence.strip()
            if len(candidate) < 40:
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
            sentences.append(candidate)
            if len(sentences) >= max_sentences:
                break
        if len(sentences) >= max_sentences:
            break
    return " ".join(sentences).strip()


def _build_best_effort_context(chunks: List[Dict[str, Any]], max_chunks: int = 6, max_chars: int = 5000) -> str:
    if not chunks:
        return ""
    parts: List[str] = []
    total = 0
    for meta in chunks[:max_chunks]:
        text = (meta.get("text") or "").strip()
        if not text:
            continue
        if len(text) > 1000:
            text = text[:1000].rsplit(" ", 1)[0] + "…"
        if total + len(text) > max_chars:
            remaining = max_chars - total
            if remaining <= 0:
                break
            text = text[:remaining].rsplit(" ", 1)[0] + "…"
        parts.append(text)
        total += len(text)
        if total >= max_chars:
            break
    return "\n\n".join(parts)


def generate_best_effort(
    settings: Settings,
    chunks: List[Dict[str, Any]],
    question: str,
    summary: bool = False,
) -> str:
    _configure(settings)
    context = _build_best_effort_context(chunks)
    if summary:
        prompt = (
            "SYSTEM:\n"
            "You are a teaching assistant. The lecture sources may be incomplete. "
            "Use them if helpful, but you MAY use general knowledge to give the best possible summary. "
            "If you rely on general knowledge, keep it concise and avoid citations.\n\n"
            "SOURCES (optional context):\n"
            f"{context}\n\n"
            "QUESTION:\n"
            f"{question}\n\n"
            "Write a 3–5 sentence catch-up summary:\n"
        )
        max_tokens = 280
        stage = "best-effort-summary"
    else:
        prompt = (
            "SYSTEM:\n"
            "You are a teaching assistant. The lecture sources may be incomplete. "
            "Use them if helpful, but you MAY use general knowledge to give the best possible answer. "
            "If you rely on general knowledge, keep it concise and avoid citations.\n\n"
            "SOURCES (optional context):\n"
            f"{context}\n\n"
            "QUESTION:\n"
            f"{question}\n\n"
            "Write a clear 4–8 sentence answer:\n"
        )
        max_tokens = 360
        stage = "best-effort-answer"

    try:
        text, _model = _generate_content_with_fallback(
            settings,
            prompt,
            {"temperature": 0.3, "max_output_tokens": max_tokens},
            stage,
        )
        return text
    except Exception as exc:  # noqa: BLE001
        logger.warning("Best-effort generation failed: %s", exc, exc_info=True)
        if summary:
            return _extractive_summary(chunks, max_sentences=4)
        return _extractive_summary(chunks, max_sentences=5)


def rewrite_from_context(settings: Settings, chunks: List[Dict[str, Any]], question: str) -> str:
    _configure(settings)
    context_lines: List[str] = []
    for chunk in chunks:
        text = chunk.get("text", "").strip()
        if text:
            context_lines.append(text)
    context = "\n".join(context_lines)
    prompt = (
        "SYSTEM:\n"
        "You are a teaching assistant. Use ONLY the provided context. "
        "Do not add outside knowledge. Do NOT copy phrases verbatim from the context.\n"
        "Write 6–10 short sentences in plain text. No bullet points, no headings, no lists.\n"
        "Prefer an explanatory tone: define the concept, then describe the key parts in natural sentences.\n\n"
        "CONTEXT:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "Answer:\n"
    )
    text, _model = _generate_content_with_fallback(
        settings,
        prompt,
        {"temperature": 0.2, "max_output_tokens": 350},
        "rewrite-from-context",
    )
    return text


def rewrite_summary_from_context(
    settings: Settings,
    chunks: List[Dict[str, Any]],
    question: str,
) -> str:
    _configure(settings)
    context_lines: List[str] = []
    for chunk in chunks:
        text = chunk.get("text", "").strip()
        if text:
            context_lines.append(text)
    context = "\n".join(context_lines)
    prompt = (
        "SYSTEM:\n"
        "You are a teaching assistant. Use ONLY the provided context. "
        "Do not add outside knowledge. Do NOT copy phrases verbatim from the context.\n"
        "Write 3–5 short sentences that summarize the lecture for a quick catch-up.\n"
        "No bullet points, no headings, no lists.\n\n"
        "CONTEXT:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}\n\n"
        "Summary:\n"
    )
    text, _model = _generate_content_with_fallback(
        settings,
        prompt,
        {"temperature": 0.2, "max_output_tokens": 240},
        "rewrite-summary",
    )
    return text


def generate_summary(settings: Settings, chunks: List[Dict[str, Any]], question: str) -> Dict[str, Any]:
    _configure(settings)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            fact_payload = _extract_summary_facts(settings, chunks, question)
            if fact_payload.get("unknown") or not fact_payload.get("facts"):
                return {
                    "answer": "I don't know based on the lecture materials.",
                    "citations": [],
                    "confidence": 0.0,
                }

            facts = fact_payload.get("facts") or []
            answer = _compose_summary(settings, question, facts)
            if answer and "don't know" not in answer.lower() and _needs_rewrite(answer):
                rewritten = _rewrite_answer(
                    settings,
                    question,
                    "\n".join([f.get("fact", "") for f in facts]),
                )
                if rewritten:
                    answer = rewritten

            citations = _dedupe_citations(facts)
            return {
                "answer": answer or "I don't know based on the lecture materials.",
                "citations": citations,
                "confidence": 0.65,
            }
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.warning(
                "Summary generation attempt %s failed: %s",
                attempt + 1,
                exc,
                exc_info=True,
            )
            time.sleep(0.5 * (attempt + 1))

    try:
        fallback = rewrite_summary_from_context(settings, chunks, question)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Summary fallback failed: %s", exc, exc_info=True)
        fallback = ""

    if not fallback:
        fallback = _extractive_summary(chunks, max_sentences=4)

    if last_error is not None:
        logger.warning("Summary generation failed after retries: %s", last_error)

    return {
        "answer": fallback or "I don't know based on the lecture materials.",
        "citations": _top_chunk_citations(chunks),
        "confidence": 0.45 if fallback else 0.35,
    }


def generate_answer(settings: Settings, chunks: List[Dict[str, Any]], question: str) -> Dict[str, Any]:
    _configure(settings)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            fact_payload = _extract_facts(settings, chunks, question)
            if fact_payload.get("unknown") or not fact_payload.get("facts"):
                return {
                    "answer": "I don't know based on the lecture materials.",
                    "citations": [],
                    "confidence": 0.0,
                }

            facts = fact_payload.get("facts") or []
            answer = _compose_answer(settings, question, facts)
            if answer and "don't know" not in answer.lower() and _needs_rewrite(answer):
                rewritten = _rewrite_answer(settings, question, "\n".join([f.get("fact", "") for f in facts]))
                if rewritten:
                    answer = rewritten

            citations = _dedupe_citations(facts)
            return {
                "answer": answer or "I don't know based on the lecture materials.",
                "citations": citations,
                "confidence": 0.7,
            }
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.warning(
                "Answer generation attempt %s failed: %s",
                attempt + 1,
                exc,
                exc_info=True,
            )
            time.sleep(0.5 * (attempt + 1))

    try:
        fallback = rewrite_from_context(settings, chunks, question)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Answer fallback failed: %s", exc, exc_info=True)
        fallback = ""

    if last_error is not None:
        logger.warning("Answer generation failed after retries: %s", last_error)
    return {
        "answer": fallback or "I don't know based on the lecture materials.",
        "citations": [],
        "confidence": 0.4,
    }
