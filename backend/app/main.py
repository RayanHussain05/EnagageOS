from fastapi import Depends, FastAPI, HTTPException, WebSocket, status

from app.core.config import Settings, get_settings
from app.core.security import verify_service_token
from app.models.schemas import AskRequest, AskResponse, IngestRequest, IngestResponse, TranscribeRequest, TranscribeResponse
from app.services.ask_pipeline import AskPipelineError, run_ask
from app.services.ingest_pipeline import IngestPipelineError, run_ingest
from app.services.live_ws import handle_live_socket
from app.services.transcribe import TranscribeError, run_transcribe

app = FastAPI(title="EngageOS RAG Service", version="0.1.0")


@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict:
    return {
        "status": "ok",
        "version": settings.APP_VERSION,
        "model": settings.GEMINI_CHAT_MODEL,
    }


@app.post(
    "/ingest",
    response_model=IngestResponse,
    dependencies=[Depends(verify_service_token)],
)
async def ingest(req: IngestRequest, settings: Settings = Depends(get_settings)) -> IngestResponse:
    try:
        chunks_created = run_ingest(settings, req)
    except IngestPipelineError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    return IngestResponse(status="ok", chunks_created=chunks_created, index=settings.PINECONE_INDEX)


@app.post(
    "/ask",
    response_model=AskResponse,
    dependencies=[Depends(verify_service_token)],
)
async def ask(req: AskRequest, settings: Settings = Depends(get_settings)) -> AskResponse:
    try:
        return run_ask(settings, req)
    except AskPipelineError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@app.post(
    "/transcribe",
    response_model=TranscribeResponse,
    dependencies=[Depends(verify_service_token)],
)
async def transcribe(req: TranscribeRequest, settings: Settings = Depends(get_settings)) -> TranscribeResponse:
    try:
        return run_transcribe(settings, req)
    except TranscribeError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@app.websocket("/live")
async def live(websocket: WebSocket, settings: Settings = Depends(get_settings)) -> None:
    await handle_live_socket(websocket, settings)
