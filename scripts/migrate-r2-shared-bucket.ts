// Copy every per-user R2 bucket's objects into the shared bucket, preserving
// keys. Source buckets are discovered via ListBuckets filtered on
// R2_BUCKET_PREFIX; staging/ is skipped; copy-only. MODE=dry lists without
// copying.
import {
  CopyObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const mode = process.env.MODE === "dry" ? "dry" : "copy";
const accountId = env("R2_ACCOUNT_ID");
const bucketPrefix = env("R2_BUCKET_PREFIX");
const targetBucket = env("R2_BUCKET_NAME");

const client = new S3Client({
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  region: "auto",
  credentials: {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  },
});

const listKeys = async (bucket: string): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key !== undefined) {
        keys.push(object.Key);
      }
    }
    continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return keys;
};

const allBuckets = await client.send(new ListBucketsCommand({}));
const sourceBuckets = (allBuckets.Buckets ?? [])
  .map((bucket) => bucket.Name)
  .filter((name): name is string => name !== undefined)
  .filter((name) => name.startsWith(`${bucketPrefix}-`) && name !== targetBucket);

console.log(
  JSON.stringify({ event: "migration_start", mode, target: targetBucket, source_buckets: sourceBuckets }),
);

if (mode === "copy") {
  try {
    await client.send(new HeadBucketCommand({ Bucket: targetBucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: targetBucket }));
    console.log(JSON.stringify({ event: "target_bucket_created", bucket: targetBucket }));
  }
}

let copied = 0;
let skippedStaging = 0;
for (const bucket of sourceBuckets) {
  const keys = await listKeys(bucket);
  const stagingKeys = keys.filter((key) => key.startsWith("staging/"));
  const copyKeys = keys.filter((key) => !key.startsWith("staging/"));
  skippedStaging += stagingKeys.length;
  if (mode === "dry") {
    console.log(
      JSON.stringify({
        event: "bucket_inventory",
        bucket,
        objects: keys.length,
        to_copy: copyKeys.length,
        staging_skipped: stagingKeys.length,
        sample: copyKeys.slice(0, 5),
      }),
    );
    continue;
  }
  const CONCURRENCY = 10;
  for (let start = 0; start < copyKeys.length; start += CONCURRENCY) {
    const chunk = copyKeys.slice(start, start + CONCURRENCY);
    await Promise.all(
      chunk.map((key) =>
        client.send(
          new CopyObjectCommand({
            Bucket: targetBucket,
            Key: key,
            CopySource: `${bucket}/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
          }),
        ),
      ),
    );
    copied += chunk.length;
  }
  console.log(JSON.stringify({ event: "bucket_copied", bucket, copied: copyKeys.length }));
}

if (mode === "copy") {
  const targetKeys = await listKeys(targetBucket);
  console.log(
    JSON.stringify({
      event: "migration_complete",
      copied,
      skipped_staging: skippedStaging,
      target_object_count: targetKeys.length,
    }),
  );
}
