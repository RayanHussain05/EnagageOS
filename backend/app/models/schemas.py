from typing import List, Optional

from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    lecture_id: str = Field(..., examples=["lec_2026_02_07"])
    file_key: str = Field(..., examples=["lectures/lec_2026_02_07.pdf"])
    course_id: Optional[str] = Field(default=None, examples=["cs101"])
    source_type: str = Field(default="pdf", examples=["pdf"])


class IngestResponse(BaseModel):
    status: str
    chunks_created: int
    index: str


class AskRequest(BaseModel):
    lecture_id: str = Field(..., examples=["lec_2026_02_07"])
    question: str = Field(..., examples=["I don't get node weighting in Dijkstra's algorithm"])
    student_id: Optional[str] = Field(default=None, examples=["stu_123"])
    course_id: Optional[str] = Field(default=None, examples=["cs101"])
    context_override: Optional[str] = Field(default=None, examples=["Manual context blob for demo"])


class Citation(BaseModel):
    source_id: str
    page: Optional[int] = None
    chunk_id: Optional[str] = None


class TopChunk(BaseModel):
    chunk_id: str
    score: float


class AskResponse(BaseModel):
    answer: str
    confidence: float
    citations: List[Citation]
    top_chunks: List[TopChunk]


class TranscribeRequest(BaseModel):
    lecture_id: str = Field(..., examples=["lec_2026_02_07"])
    session_id: Optional[str] = Field(default=None, examples=["session_123"])
    audio_base64: str = Field(..., description="Base64-encoded audio chunk")
    mime_type: str = Field(default="audio/webm", examples=["audio/webm"])


class TranscribeResponse(BaseModel):
    text: str
