from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    PINECONE_API_KEY: str
    PINECONE_HOST: str
    PINECONE_INDEX: str = "engageos-lectures"

    GEMINI_API_KEY: str
    GEMINI_EMBEDDING_MODEL: str = "gemini-embedding-001"
    GEMINI_EMBEDDING_DIM: int = 1056
    GEMINI_CHAT_MODEL: str = "gemini-1.5-pro"
    GEMINI_TRANSCRIBE_MODEL: str = "gemini-2.5-flash"
    GEMINI_LIVE_MODEL: str = "gemini-2.5-flash-native-audio-preview-12-2025"
    GEMINI_LIVE_RESPONSE_MODALITIES: str = "AUDIO"
    GEMINI_FALLBACK_MODELS: str = ""
    GEMINI_SAFETY: str = "block_only_high"
    DEMO_CONTEXT_ENABLED: bool = False
    DEMO_CONTEXT_FILE: str = "app/demo_context.txt"

    R2_ACCOUNT_ID: str
    R2_ACCESS_KEY_ID: str
    R2_SECRET_ACCESS_KEY: str
    R2_BUCKET: str
    R2_ENDPOINT: str

    SERVICE_TOKEN: str
    TRANSCRIBE_WS_SECRET: str = ""
    APP_VERSION: str = "dev"


@lru_cache
def get_settings() -> Settings:
    return Settings()
