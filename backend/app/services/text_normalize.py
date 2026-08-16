from __future__ import annotations

import re


_HYPHEN_BREAK = re.compile(r"-\n")
_LINE_BREAKS = re.compile(r"\s*\n\s*")
_MULTI_SPACE = re.compile(r"\s{2,}")


def normalize_text(text: str) -> str:
    if not text:
        return ""
    text = _HYPHEN_BREAK.sub("", text)
    text = _LINE_BREAKS.sub(" ", text)
    text = _MULTI_SPACE.sub(" ", text)
    return text.strip()
