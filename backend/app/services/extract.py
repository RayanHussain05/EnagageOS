from __future__ import annotations

import io
from typing import List, Tuple

from pypdf import PdfReader


def extract_text_from_pdf(data: bytes) -> List[Tuple[int, str]]:
    reader = PdfReader(io.BytesIO(data))
    pages: List[Tuple[int, str]] = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append((i, text))
    return pages
