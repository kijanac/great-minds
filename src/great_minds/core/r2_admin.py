"""R2 bucket provisioning.

Companion to ``R2Storage`` (data plane). This module owns the admin
plane: deriving a deterministic per-user bucket name and idempotently
creating the bucket on Cloudflare R2 via the S3 API.

The same admin credentials drive both planes — R2 doesn't issue
per-bucket service tokens by default, and surfacing customer-managed
creds is a separate (deferred) concern.
"""


import asyncio
import logging
import time
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

from great_minds.core.telemetry import log_event

log = logging.getLogger(__name__)

# R2 buckets: 3-63 chars, lowercase letters / digits / hyphens, must
# start and end with a letter or digit. ``{prefix}-{uuid_hex}`` fits
# comfortably (e.g. ``gm-`` + 32 hex = 35 chars).
_MAX_BUCKET_NAME_LEN = 63
_BUCKET_ALREADY_OWNED = ("BucketAlreadyOwnedByYou", "BucketAlreadyExists")


def derive_user_bucket_name(prefix: str, user_id: UUID) -> str:
    """Deterministic bucket name for a user. Hex (no dashes) for length."""
    name = f"{prefix}-{user_id.hex}"
    if len(name) > _MAX_BUCKET_NAME_LEN:
        raise ValueError(
            f"r2_bucket_prefix too long: {prefix!r} produces {len(name)}-char "
            f"bucket name (max {_MAX_BUCKET_NAME_LEN})"
        )
    return name


class R2Admin:
    """Bucket-level admin operations on Cloudflare R2."""

    def __init__(
        self,
        *,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
    ) -> None:
        self._client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

    def _head_sync(self, bucket: str) -> bool:
        try:
            self._client.head_bucket(Bucket=bucket)
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code in ("404", "NoSuchBucket", "NotFound"):
                return False
            raise
        return True

    def _create_sync(self, bucket: str) -> None:
        try:
            self._client.create_bucket(Bucket=bucket)
        except ClientError as e:
            if e.response["Error"]["Code"] in _BUCKET_ALREADY_OWNED:
                return
            raise

    async def ensure_bucket(
        self,
        bucket: str,
        *,
        cors_origins: list[str] | None = None,
    ) -> None:
        """Idempotently create ``bucket`` and apply standard policies.

        Standard policies are applied every call (CORS for direct browser
        PUTs, lifecycle to expire ``staging/`` after 24h). ``put_*`` calls
        are idempotent on R2, so running them on every vault creation is
        cheap and keeps drift impossible.
        """
        t0 = time.perf_counter()
        try:
            exists = await asyncio.to_thread(self._head_sync, bucket)
            if not exists:
                await asyncio.to_thread(self._create_sync, bucket)
            if cors_origins:
                await asyncio.to_thread(
                    self._client.put_bucket_cors,
                    Bucket=bucket,
                    CORSConfiguration={
                        "CORSRules": [
                            {
                                "AllowedMethods": ["PUT"],
                                "AllowedOrigins": cors_origins,
                                "AllowedHeaders": [
                                    "Content-Type",
                                    "Content-Length",
                                ],
                                "ExposeHeaders": ["ETag"],
                                "MaxAgeSeconds": 3600,
                            }
                        ]
                    },
                )
            await asyncio.to_thread(
                self._client.put_bucket_lifecycle_configuration,
                Bucket=bucket,
                LifecycleConfiguration={
                    "Rules": [
                        {
                            "ID": "expire-staging",
                            "Status": "Enabled",
                            "Filter": {"Prefix": "staging/"},
                            "Expiration": {"Days": 1},
                        }
                    ]
                },
            )
            log_event(
                "r2_admin.ensure_bucket",
                bucket=bucket,
                created=not exists,
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
        except Exception as e:
            log_event(
                "r2_admin.ensure_bucket",
                level=logging.WARNING,
                bucket=bucket,
                error=type(e).__name__,
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
            raise

    def presign_put(
        self,
        bucket: str,
        key: str,
        *,
        content_type: str,
        content_length: int,
        expires_in: int = 3600,
    ) -> str:
        """Sign a PUT URL with pinned Content-Type and Content-Length.

        boto3's ``generate_presigned_url`` is sync but does no I/O — it's
        a local hash + sign over the request params. No to_thread needed.
        """
        return self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": bucket,
                "Key": key,
                "ContentType": content_type,
                "ContentLength": content_length,
            },
            ExpiresIn=expires_in,
        )

    def _fetch_bytes_sync(self, bucket: str, key: str) -> bytes:
        resp = self._client.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read()

    async def fetch_bytes(self, bucket: str, key: str) -> bytes:
        return await asyncio.to_thread(self._fetch_bytes_sync, bucket, key)

    def _delete_object_sync(self, bucket: str, key: str) -> None:
        try:
            self._client.delete_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return
            raise

    async def delete_object(self, bucket: str, key: str) -> None:
        await asyncio.to_thread(self._delete_object_sync, bucket, key)

    def _delete_sync(self, bucket: str) -> bool:
        try:
            self._client.delete_bucket(Bucket=bucket)
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code in ("404", "NoSuchBucket", "NotFound"):
                return False
            raise
        return True

    async def delete_bucket(self, bucket: str) -> None:
        """Delete ``bucket``. Caller must empty it first (R2/S3 requirement).

        Idempotent on absence — missing-bucket is treated as success.
        """
        t0 = time.perf_counter()
        try:
            existed = await asyncio.to_thread(self._delete_sync, bucket)
            log_event(
                "r2_admin.delete_bucket",
                bucket=bucket,
                deleted=existed,
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
        except Exception as e:
            log_event(
                "r2_admin.delete_bucket",
                level=logging.WARNING,
                bucket=bucket,
                error=type(e).__name__,
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
            raise
