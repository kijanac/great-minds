"""Storage abstraction for vault data.

All paths passed to Storage methods are relative to the vault root.
Example: "wiki/imperialism.md", "raw/texts/lenin/works/1893/market/01.md"

Two backends implement the Storage protocol:

- LocalStorage: filesystem directory.
- R2Storage: Cloudflare R2 bucket with a per-vault key prefix.

The Protocol is async throughout because R2 calls block on network I/O;
under async FastAPI handlers that would stall the event loop. LocalStorage
keeps sync filesystem calls inside ``async def`` — filesystem latency is
microseconds, so wrapping in ``asyncio.to_thread`` would add more overhead
than it saves. R2Storage wraps each boto3 call in ``asyncio.to_thread``
because boto3 is fully synchronous.

Compile-sidecar paths (``.compile/...``) never flow through Storage —
they're machine-local filesystem paths managed directly. See
``great_minds.core.paths`` for the split.
"""


import asyncio
import fnmatch
import logging
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol, TypeVar, runtime_checkable

import boto3
from botocore.exceptions import ClientError

from great_minds.core.telemetry import log_event

T = TypeVar("T")


@runtime_checkable
class Storage(Protocol):
    """Structural interface for vault file storage."""

    async def read(self, path: str, *, strict: bool = True) -> str | None: ...
    async def write(self, path: str, content: str) -> None: ...
    async def exists(self, path: str) -> bool: ...
    async def glob(self, pattern: str) -> list[str]: ...
    async def append(self, path: str, content: str) -> None: ...
    async def mkdir(self, path: str) -> None: ...
    async def delete(self, path: str, *, missing_ok: bool = True) -> None: ...
    async def clear(self) -> None: ...


class LocalStorage:
    """Storage backed by a local filesystem directory."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()

    def _resolve(self, path: str) -> Path:
        resolved = (self.root / path).resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError(f"Path escapes storage root: {path}")
        return resolved

    async def read(self, path: str, *, strict: bool = True) -> str | None:
        """Read text content. Returns None if strict=False and path doesn't exist."""
        try:
            return self._resolve(path).read_text(encoding="utf-8")
        except FileNotFoundError:
            if strict:
                raise
            return None

    async def write(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")

    async def exists(self, path: str) -> bool:
        return self._resolve(path).exists()

    async def glob(self, pattern: str) -> list[str]:
        matches = sorted(self.root.glob(pattern))
        return [str(m.relative_to(self.root)) for m in matches]

    async def append(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        with full.open("a", encoding="utf-8") as f:
            f.write(content)

    async def mkdir(self, path: str) -> None:
        self._resolve(path).mkdir(parents=True, exist_ok=True)

    async def delete(self, path: str, *, missing_ok: bool = True) -> None:
        self._resolve(path).unlink(missing_ok=missing_ok)

    async def clear(self) -> None:
        """Remove the storage root and all its contents. Subsequent writes recreate parents."""
        if self.root.exists():
            shutil.rmtree(self.root)


class R2Storage:
    """Storage backed by a Cloudflare R2 bucket.

    All keys are written under a per-vault prefix (e.g. ``vaults/<id>/``).
    R2 has no concept of directories — ``mkdir`` is a no-op.

    Uses synchronous boto3 wrapped in ``asyncio.to_thread`` so that
    network calls don't block the event loop. This is the FastAPI-idiomatic
    bridge for sync SDKs; ``aioboto3`` has known issues where aiobotocore
    internally calls sync boto3 functions in several paths (see deferred-
    infra memory).
    """

    def __init__(
        self,
        *,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        prefix: str,
    ) -> None:
        self.bucket = bucket
        self.prefix = prefix.rstrip("/")
        self._client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

    def _key(self, path: str) -> str:
        return f"{self.prefix}/{path}"

    def _strip_prefix(self, key: str) -> str:
        return key[len(self.prefix) + 1 :]

    async def _timed(
        self,
        op: str,
        path: str,
        sync_fn: Callable[[], T],
    ) -> tuple[T, int]:
        """Run a boto3 op in a thread, log on failure, return (result, latency_ms).

        Success-path logging lives at the call site so each op can emit
        op-specific fields (hit, bytes, match_count) without a dict-spread
        helper that fights the type checker.
        """
        t0 = time.perf_counter()
        try:
            result = await asyncio.to_thread(sync_fn)
        except Exception as e:
            log_event(
                "storage.r2_op",
                level=logging.WARNING,
                op=op,
                path=path,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                error=type(e).__name__,
            )
            raise
        return result, int((time.perf_counter() - t0) * 1000)

    def _read_sync(self, path: str, *, strict: bool) -> str | None:
        try:
            resp = self._client.get_object(Bucket=self.bucket, Key=self._key(path))
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                if strict:
                    raise FileNotFoundError(path) from e
                return None
            raise
        return resp["Body"].read().decode("utf-8")

    async def read(self, path: str, *, strict: bool = True) -> str | None:
        result, latency_ms = await self._timed(
            "read", path, lambda: self._read_sync(path, strict=strict)
        )
        log_event(
            "storage.r2_op",
            op="read",
            path=path,
            latency_ms=latency_ms,
            hit=result is not None,
            bytes=len(result) if result else 0,
        )
        return result

    def _write_sync(self, path: str, content: str) -> None:
        self._client.put_object(
            Bucket=self.bucket,
            Key=self._key(path),
            Body=content.encode("utf-8"),
            ContentType="text/markdown" if path.endswith(".md") else "text/plain",
        )

    async def write(self, path: str, content: str) -> None:
        _, latency_ms = await self._timed(
            "write", path, lambda: self._write_sync(path, content)
        )
        log_event(
            "storage.r2_op",
            op="write",
            path=path,
            latency_ms=latency_ms,
            bytes=len(content),
        )

    def _exists_sync(self, path: str) -> bool:
        try:
            self._client.head_object(Bucket=self.bucket, Key=self._key(path))
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return False
            raise
        return True

    async def exists(self, path: str) -> bool:
        result, latency_ms = await self._timed(
            "exists", path, lambda: self._exists_sync(path)
        )
        log_event(
            "storage.r2_op",
            op="exists",
            path=path,
            latency_ms=latency_ms,
            hit=result,
        )
        return result

    def _glob_sync(self, pattern: str) -> list[str]:
        if "**/" in pattern:
            list_prefix, filename_pattern = pattern.split("**/", 1)
            recursive = True
        elif "/*" in pattern:
            dir_part, _, filename_pattern = pattern.rpartition("/")
            list_prefix = f"{dir_part}/" if dir_part else ""
            recursive = False
        else:
            raise ValueError(f"Unsupported glob pattern: {pattern!r}")

        full_prefix = self._key(list_prefix)
        paginator = self._client.get_paginator("list_objects_v2")
        kwargs: dict = {"Bucket": self.bucket, "Prefix": full_prefix}
        if not recursive:
            kwargs["Delimiter"] = "/"

        matches: list[str] = []
        for page in paginator.paginate(**kwargs):
            for obj in page.get("Contents", []):
                rel = self._strip_prefix(obj["Key"])
                filename = rel.rsplit("/", 1)[-1]
                if fnmatch.fnmatch(filename, filename_pattern):
                    matches.append(rel)
        return sorted(matches)

    async def glob(self, pattern: str) -> list[str]:
        """Match a glob pattern against keys under the vault prefix.

        Supports patterns like ``raw/**/*.md`` (recursive) and
        ``wiki/*.md`` (single-level). The pattern's leading path segment
        becomes the R2 prefix; the trailing filename portion is matched
        via fnmatch against each object's basename.
        """
        result, latency_ms = await self._timed(
            "glob", pattern, lambda: self._glob_sync(pattern)
        )
        log_event(
            "storage.r2_op",
            op="glob",
            path=pattern,
            latency_ms=latency_ms,
            match_count=len(result),
        )
        return result

    async def append(self, path: str, content: str) -> None:
        """R2 has no native append — read, concatenate, write."""
        existing = await self.read(path, strict=False) or ""
        await self.write(path, existing + content)

    async def mkdir(self, path: str) -> None:
        """No-op: R2 has no directory concept."""

    def _delete_sync(self, path: str, *, missing_ok: bool) -> None:
        try:
            self._client.delete_object(Bucket=self.bucket, Key=self._key(path))
        except ClientError as e:
            if not missing_ok and e.response["Error"]["Code"] in (
                "NoSuchKey",
                "404",
            ):
                raise FileNotFoundError(path) from e
            if e.response["Error"]["Code"] not in ("NoSuchKey", "404"):
                raise

    async def delete(self, path: str, *, missing_ok: bool = True) -> None:
        _, latency_ms = await self._timed(
            "delete", path, lambda: self._delete_sync(path, missing_ok=missing_ok)
        )
        log_event(
            "storage.r2_op",
            op="delete",
            path=path,
            latency_ms=latency_ms,
        )

    def _clear_sync(self) -> int:
        """List + batch-delete every key under the vault prefix. Returns count."""
        paginator = self._client.get_paginator("list_objects_v2")
        full_prefix = f"{self.prefix}/"
        deleted = 0
        for page in paginator.paginate(Bucket=self.bucket, Prefix=full_prefix):
            keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if not keys:
                continue
            # delete_objects accepts up to 1000 keys per request — list_objects_v2
            # already paginates at that boundary, so each page is one delete call.
            self._client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True}
            )
            deleted += len(keys)
        return deleted

    async def clear(self) -> None:
        """Delete every key under this vault's prefix. Bucket stays intact."""
        deleted, latency_ms = await self._timed(
            "clear", self.prefix, self._clear_sync
        )
        log_event(
            "storage.r2_op",
            op="clear",
            path=self.prefix,
            latency_ms=latency_ms,
            match_count=deleted,
        )
