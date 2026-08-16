from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict

import websockets
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.core.config import Settings

logger = logging.getLogger(__name__)

LIVE_API_ENDPOINT = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)


class LiveTranscribeError(RuntimeError):
    pass


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(f"{data}{padding}")


def _verify_token(token: str, secret: str) -> dict | None:
    if not token or not secret:
        return None
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        return None

    expected_sig = hmac.new(secret.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).digest()
    expected_b64 = base64.urlsafe_b64encode(expected_sig).decode("utf-8").rstrip("=")
    if not hmac.compare_digest(expected_b64, sig):
        return None

    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None

    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        return None
    return payload


def _response_modalities(settings: Settings) -> list[str]:
    raw = (getattr(settings, "GEMINI_LIVE_RESPONSE_MODALITIES", "") or "AUDIO").strip()
    tokens = [token.strip().upper() for token in raw.split(",") if token.strip()]
    allowed = []
    for token in tokens:
        if token in ("AUDIO", "TEXT"):
            allowed.append(token)
    return allowed or ["AUDIO"]


def _build_setup(settings: Settings) -> Dict[str, Any]:
    model = (getattr(settings, "GEMINI_LIVE_MODEL", "") or "").strip()
    if not model:
        raise LiveTranscribeError("GEMINI_LIVE_MODEL is not configured")
    if not model.startswith("models/"):
        model = f"models/{model}"

    setup: Dict[str, Any] = {
        "model": model,
        "generationConfig": {
            "responseModalities": _response_modalities(settings),
            "temperature": 0.2,
            "maxOutputTokens": 512,
        },
        "inputAudioTranscription": {},
    }

    return {"setup": setup}


async def _await_setup_complete(ws: websockets.WebSocketClientProtocol, timeout_s: float = 10.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        raw = await ws.recv()
        data = json.loads(raw)
        if "error" in data:
            raise LiveTranscribeError(f"Gemini Live setup error: {data['error']}")
        if "setupComplete" in data:
            return
    raise LiveTranscribeError("Gemini Live setup timeout")


async def _bridge_client_to_gemini(
    client_ws: WebSocket,
    gemini_ws: websockets.WebSocketClientProtocol,
) -> None:
    while True:
        try:
            message = await client_ws.receive_text()
        except WebSocketDisconnect:
            break

        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            continue

        msg_type = payload.get("type")
        if msg_type == "audio":
            audio_data = payload.get("data")
            mime_type = payload.get("mimeType") or "audio/pcm;rate=16000"
            if not audio_data:
                continue
            await gemini_ws.send(
                json.dumps(
                    {
                        "realtimeInput": {
                            "audio": {
                                "data": audio_data,
                                "mimeType": mime_type,
                            }
                        }
                    }
                )
            )
        elif msg_type == "stop":
            await gemini_ws.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
            break


async def _bridge_gemini_to_client(
    client_ws: WebSocket,
    gemini_ws: websockets.WebSocketClientProtocol,
) -> None:
    while True:
        raw = await gemini_ws.recv()
        data = json.loads(raw)
        if "error" in data:
            await client_ws.send_json({"type": "error", "message": str(data["error"])})
            break

        server_content = data.get("serverContent")
        if not server_content:
            continue
        input_tx = server_content.get("inputTranscription") or {}
        text = (input_tx.get("text") or "").strip()
        if text:
            await client_ws.send_json({"type": "transcript", "text": text})


async def handle_live_socket(websocket: WebSocket, settings: Settings) -> None:
    token = websocket.query_params.get("token", "")
    claims = _verify_token(token, getattr(settings, "TRANSCRIBE_WS_SECRET", "") or "")
    if not claims:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Invalid or expired token"})
        await websocket.close(code=1008)
        return

    await websocket.accept()

    try:
        gemini_url = f"{LIVE_API_ENDPOINT}?key={settings.GEMINI_API_KEY}"
        async with websockets.connect(
            gemini_url,
            ping_interval=20,
            ping_timeout=20,
            max_size=8_000_000,
        ) as gemini_ws:
            await gemini_ws.send(json.dumps(_build_setup(settings)))
            await _await_setup_complete(gemini_ws)
            await websocket.send_json({"type": "ready"})

            client_task = asyncio.create_task(_bridge_client_to_gemini(websocket, gemini_ws))
            gemini_task = asyncio.create_task(_bridge_gemini_to_client(websocket, gemini_ws))

            done, pending = await asyncio.wait(
                {client_task, gemini_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc
    except LiveTranscribeError as exc:
        logger.warning("Gemini live transcription error: %s", exc)
        if websocket.application_state == WebSocketState.CONNECTED:
            message = str(exc)
            await websocket.send_json({"type": "error", "message": message})
            await websocket.close(code=1011, reason=message[:120])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Gemini live transcription failed")
        if websocket.application_state == WebSocketState.CONNECTED:
            message = str(exc)
            await websocket.send_json({"type": "error", "message": message})
            await websocket.close(code=1011, reason=message[:120])
