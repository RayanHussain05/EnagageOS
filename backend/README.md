# EngageOS RAG Service (FastAPI)

This service handles lecture ingestion (R2 -> embeddings -> Pinecone) and question answering (RAG -> Gemini). It is intended to be deployed to Cloud Run and called from Convex.

## Endpoints
- `GET /health` — health check
- `POST /ingest` — ingest lecture file from R2 and upsert embeddings into Pinecone
- `POST /ask` — answer a question using RAG over lecture content
- `POST /transcribe` — best-effort chunk transcription (non-live)
- `WS /live` — Gemini Live transcription stream (WebSocket)

## Environment variables
- `PINECONE_API_KEY`
- `PINECONE_HOST`
- `PINECONE_INDEX` (default: `engageos-lectures`)
- `GEMINI_API_KEY`
- `GEMINI_EMBEDDING_MODEL` (default: `gemini-embedding-001`)
- `GEMINI_EMBEDDING_DIM` (default: `1056`)
- `GEMINI_CHAT_MODEL` (default: `gemini-1.5-pro`)
- `GEMINI_TRANSCRIBE_MODEL` (default: `gemini-2.5-flash`)
- `GEMINI_LIVE_MODEL` (default: `gemini-2.5-flash-native-audio-preview-12-2025`)
- `GEMINI_LIVE_RESPONSE_MODALITIES` (default: `AUDIO`)
- `GEMINI_FALLBACK_MODELS` (default: empty)
- `GEMINI_SAFETY` (default: `block_only_high`, options: `block_only_high`, `block_none`, `default`)
- `DEMO_CONTEXT_ENABLED` (default: `false`)
- `DEMO_CONTEXT_FILE` (default: `app/demo_context.txt`)
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_ENDPOINT` (S3 API endpoint)
- `SERVICE_TOKEN` (shared secret used by Convex)
- `TRANSCRIBE_WS_SECRET` (HMAC secret for live transcription WS tokens)

## Local run (once code is implemented)
1. Create a virtualenv and install requirements.
2. Export env vars (or create a local `.env`).
3. Run: `uvicorn app.main:app --reload`.

## Deployment
Use the provided `Dockerfile` and deploy to Cloud Run. Expose port `8080`.
