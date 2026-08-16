from __future__ import annotations

import io
from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import Settings


def _normalize_endpoint(endpoint: str, bucket: str) -> str:
    endpoint = endpoint.rstrip("/")
    suffix = f"/{bucket}"
    if endpoint.endswith(suffix):
        return endpoint[: -len(suffix)]
    return endpoint


@lru_cache
def _get_s3_client(
    endpoint_url: str,
    access_key_id: str,
    secret_access_key: str,
) -> boto3.client:
    config = Config(
        region_name="auto",
        retries={"max_attempts": 3, "mode": "standard"},
        signature_version="s3v4",
    )
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=config,
    )


def download_object(settings: Settings, key: str) -> bytes:
    endpoint = _normalize_endpoint(settings.R2_ENDPOINT, settings.R2_BUCKET)
    client = _get_s3_client(
        endpoint,
        settings.R2_ACCESS_KEY_ID,
        settings.R2_SECRET_ACCESS_KEY,
    )

    try:
        obj = client.get_object(Bucket=settings.R2_BUCKET, Key=key)
        body = obj.get("Body")
        if body is None:
            raise RuntimeError("R2 response missing body")
        with io.BytesIO() as buf:
            for chunk in body.iter_chunks():
                if chunk:
                    buf.write(chunk)
            return buf.getvalue()
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        raise RuntimeError(f"R2 get_object failed: {code}") from exc
