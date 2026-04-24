"""Storage abstraction for brain data.

All paths passed to Storage methods are relative to the brain root.
Example: "wiki/imperialism.md", "raw/texts/lenin/works/1893/market/01.md"

Two backends implement the Storage protocol:

- LocalStorage: filesystem directory.
- R2Storage: Cloudflare R2 bucket with a per-brain key prefix.

Compile-sidecar paths (``.compile/...``) never flow through Storage —
they're machine-local filesystem paths managed directly. See
``great_minds.core.paths`` for the split.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Protocol, runtime_checkable


@runtime_checkable
class Storage(Protocol):
    """Structural interface for brain file storage."""

    def read(self, path: str, *, strict: bool = True) -> str | None: ...
    def write(self, path: str, content: str) -> None: ...
    def exists(self, path: str) -> bool: ...
    def glob(self, pattern: str) -> list[str]: ...
    def append(self, path: str, content: str) -> None: ...
    def mkdir(self, path: str) -> None: ...
    def delete(self, path: str, *, missing_ok: bool = True) -> None: ...


class LocalStorage:
    """Storage backed by a local filesystem directory."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()

    def _resolve(self, path: str) -> Path:
        resolved = (self.root / path).resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError(f"Path escapes storage root: {path}")
        return resolved

    def read(self, path: str, *, strict: bool = True) -> str | None:
        """Read text content. Returns None if strict=False and path doesn't exist."""
        try:
            return self._resolve(path).read_text(encoding="utf-8")
        except FileNotFoundError:
            if strict:
                raise
            return None

    def write(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")

    def exists(self, path: str) -> bool:
        return self._resolve(path).exists()

    def glob(self, pattern: str) -> list[str]:
        matches = sorted(self.root.glob(pattern))
        return [str(m.relative_to(self.root)) for m in matches]

    def append(self, path: str, content: str) -> None:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        with full.open("a", encoding="utf-8") as f:
            f.write(content)

    def mkdir(self, path: str) -> None:
        self._resolve(path).mkdir(parents=True, exist_ok=True)

    def delete(self, path: str, *, missing_ok: bool = True) -> None:
        self._resolve(path).unlink(missing_ok=missing_ok)


class R2Storage:
    """Storage backed by a Cloudflare R2 bucket.

    All keys are written under a per-brain prefix (e.g. ``brains/<id>/``).
    R2 has no concept of directories — ``mkdir`` is a no-op.

    Uses synchronous boto3 under the hood. Calls block the event loop;
    at the pipeline's bounded concurrency (``compile_enrich_concurrency``,
    etc.) this is acceptable for MVP. If it becomes a bottleneck, wrap
    individual calls in ``asyncio.to_thread`` at the call site.
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
        import boto3

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

    def read(self, path: str, *, strict: bool = True) -> str | None:
        from botocore.exceptions import ClientError

        try:
            resp = self._client.get_object(Bucket=self.bucket, Key=self._key(path))
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                if strict:
                    raise FileNotFoundError(path) from e
                return None
            raise
        return resp["Body"].read().decode("utf-8")

    def write(self, path: str, content: str) -> None:
        self._client.put_object(
            Bucket=self.bucket,
            Key=self._key(path),
            Body=content.encode("utf-8"),
            ContentType="text/markdown" if path.endswith(".md") else "text/plain",
        )

    def exists(self, path: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=self.bucket, Key=self._key(path))
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return False
            raise
        return True

    def glob(self, pattern: str) -> list[str]:
        """Match a glob pattern against keys under the brain prefix.

        Supports patterns like ``raw/**/*.md`` (recursive) and
        ``wiki/*.md`` (single-level). The pattern's leading path segment
        becomes the R2 prefix; the trailing filename portion is matched
        via fnmatch against each object's basename.
        """
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

    def append(self, path: str, content: str) -> None:
        """R2 has no native append — read, concatenate, write."""
        existing = self.read(path, strict=False) or ""
        self.write(path, existing + content)

    def mkdir(self, path: str) -> None:
        """No-op: R2 has no directory concept."""

    def delete(self, path: str, *, missing_ok: bool = True) -> None:
        from botocore.exceptions import ClientError

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
