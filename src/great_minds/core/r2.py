"""Utility functions for reading from the R2 corpus bucket."""

from __future__ import annotations

import boto3


def make_client(endpoint_url: str, access_key_id: str, secret_access_key: str):
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
    )


def list_objects(
    client,
    bucket: str,
    prefix: str = "",
    delimiter: str = "",
) -> list[dict]:
    """Return a flat list of objects under *prefix*."""
    paginator = client.get_paginator("list_objects_v2")
    kwargs: dict = {"Bucket": bucket}
    if prefix:
        kwargs["Prefix"] = prefix
    if delimiter:
        kwargs["Delimiter"] = delimiter

    results: list[dict] = []
    for page in paginator.paginate(**kwargs):
        for obj in page.get("Contents", []):
            results.append(
                {
                    "key": obj["Key"],
                    "size": obj["Size"],
                    "last_modified": obj["LastModified"].isoformat(),
                }
            )
    return results


def list_prefixes(client, bucket: str, prefix: str = "") -> list[str]:
    """Return immediate sub-prefixes (like top-level 'directories')."""
    response = client.list_objects_v2(
        Bucket=bucket,
        Prefix=prefix,
        Delimiter="/",
    )
    return [cp["Prefix"] for cp in response.get("CommonPrefixes", [])]


def read_object(client, bucket: str, key: str) -> str:
    """Read and return the UTF-8 text content of an object."""
    response = client.get_object(Bucket=bucket, Key=key)
    return response["Body"].read().decode("utf-8")
