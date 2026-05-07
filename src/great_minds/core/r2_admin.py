"""R2 bucket provisioning.

Companion to ``R2Storage`` (data plane). This module owns the admin
plane: deriving a deterministic per-user bucket name and idempotently
creating the bucket on Cloudflare R2 via the S3 API.

The same admin credentials drive both planes — R2 doesn't issue
per-bucket service tokens by default, and surfacing customer-managed
creds is a separate (deferred) concern.
"""

from dataclasses import dataclass
import logging
import time
from uuid import UUID

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from great_minds.core.settings import get_settings
from great_minds.core.telemetry import log_event

log = logging.getLogger(__name__)

# R2 buckets: 3-63 chars, lowercase letters / digits / hyphens, must
# start and end with a letter or digit. ``{prefix}-{uuid_hex}`` fits
# comfortably (e.g. ``gm-`` + 32 hex = 35 chars).
_MAX_BUCKET_NAME_LEN = 63
_BUCKET_MISSING = frozenset({"404", "NoSuchBucket", "NotFound"})
_OBJECT_MISSING = frozenset({"404", "NoSuchKey", "NotFound"})
_BUCKET_ALREADY_OWNED = frozenset({"BucketAlreadyOwnedByYou"})


@dataclass(frozen=True)
class _R2ClientError:
    """Parsed shape of boto3's loose ClientError response."""

    code: str
    status_code: int | None
    message: str

    @classmethod
    def parse(cls, error: ClientError) -> "_R2ClientError":
        payload = error.response
        error_info = payload.get("Error", {})
        metadata = payload.get("ResponseMetadata", {})
        status = metadata.get("HTTPStatusCode")
        return cls(
            code=str(error_info.get("Code", "")),
            status_code=status if isinstance(status, int) else None,
            message=str(error_info.get("Message", "")),
        )

    def has_code(self, codes: frozenset[str]) -> bool:
        return self.code in codes


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
            config=BotoConfig(
                max_pool_connections=get_settings().compile_enrich_concurrency
            ),
        )

    def _bucket_exists(self, bucket: str) -> bool:
        try:
            self._client.head_bucket(Bucket=bucket)
        except ClientError as e:
            if _R2ClientError.parse(e).has_code(_BUCKET_MISSING):
                return False
            raise
        return True

    def _create_bucket(self, bucket: str) -> None:
        try:
            self._client.create_bucket(Bucket=bucket)
        except ClientError as e:
            if _R2ClientError.parse(e).has_code(_BUCKET_ALREADY_OWNED):
                return
            raise

    def ensure_bucket(
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
            exists = self._bucket_exists(bucket)
            if not exists:
                self._create_bucket(bucket)
            if cors_origins:
                self._client.put_bucket_cors(
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
            self._client.put_bucket_lifecycle_configuration(
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

    def fetch_bytes(self, bucket: str, key: str) -> bytes:
        resp = self._client.get_object(Bucket=bucket, Key=key)
        body = resp["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def delete_object(self, bucket: str, key: str) -> None:
        try:
            self._client.delete_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if _R2ClientError.parse(e).has_code(_OBJECT_MISSING):
                return
            raise

    def _delete_bucket(self, bucket: str) -> bool:
        try:
            self._client.delete_bucket(Bucket=bucket)
        except ClientError as e:
            if _R2ClientError.parse(e).has_code(_BUCKET_MISSING):
                return False
            raise
        return True

    def delete_bucket(self, bucket: str) -> None:
        """Delete ``bucket``. Caller must empty it first (R2/S3 requirement).

        Idempotent on absence — missing-bucket is treated as success.
        """
        t0 = time.perf_counter()
        try:
            existed = self._delete_bucket(bucket)
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
