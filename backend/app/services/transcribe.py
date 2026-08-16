from __future__ import annotations

import base64
import logging
import time
from typing import Any, Dict

import google.generativeai as genai
from google.generativeai import types as genai_types

from app.core.config import Settings
from app.models.schemas import TranscribeRequest, TranscribeResponse

logger = logging.getLogger(__name__)


class TranscribeError(RuntimeError):
    pass


def _configure(settings: Settings) -> None:
    genai.configure(api_key=settings.GEMINI_API_KEY)


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
        texts = []
        for part in parts:
            part_text = getattr(part, "text", None)
            if part_text:
                texts.append(part_text)
        if texts:
            return "\n".join(texts).strip()

    raise TranscribeError("Gemini response contained no text parts")


def _normalize_mime(mime_type: str) -> str:
    if not mime_type:
        return "audio/webm"
    base = mime_type.split(";")[0].strip().lower()
    if base in ("audio/x-wav", "audio/wave"):
        return "audio/wav"
    return base


def _is_refusal(text: str) -> bool:
    lowered = text.lower()
    return any(
        phrase in lowered
        for phrase in (
            "cannot process audio",
            "can't process audio",
            "cannot provide a transcript",
            "can't provide a transcript",
            "i cannot process audio",
            "i can't process audio",
        )
    )


def _generate_transcript(settings: Settings, audio_bytes: bytes, mime_type: str) -> str:
    _configure(settings)
    if not audio_bytes:
        return ""

    prompt = (
        "SYSTEM:\n"
        "Transcribe the audio clearly. Return only the transcript, no extra commentary. "
        "If there is no speech, return an empty string.\n\n"
        "TRANSCRIPT:\n"
    )

    last_error: Exception | None = None
    normalized_mime = _normalize_mime(mime_type)
    for attempt in range(3):
        try:
            model = genai.GenerativeModel(settings.GEMINI_TRANSCRIBE_MODEL)
            response = model.generate_content(
                [
                    prompt,
                    {
                        "inline_data": {
                            "mime_type": normalized_mime,
                            "data": audio_bytes,
                        }
                    },
                ],
                generation_config={"temperature": 0.1, "max_output_tokens": 800},
                safety_settings=_safety_settings(settings),
            )
            text = _response_text(response)
            if _is_refusal(text):
                raise TranscribeError("Model refused to process audio input")
            return text
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.warning("Gemini transcribe attempt %s failed: %s", attempt + 1, exc, exc_info=True)
            time.sleep(0.4 * (attempt + 1))

    raise TranscribeError("Gemini transcription failed") from last_error


def run_transcribe(settings: Settings, req: TranscribeRequest) -> TranscribeResponse:
    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception as exc:  # noqa: BLE001
        raise TranscribeError("Invalid audio base64 payload") from exc

    text = _generate_transcript(settings, audio_bytes, req.mime_type)
    return TranscribeResponse(text=text)
