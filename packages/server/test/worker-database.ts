const pool = process.env.VITEST_POOL_ID;

if (process.env.REPLY_HISTORY_TEST_WORKERS !== undefined && pool !== undefined) {
  for (const key of ["DATABASE_URL", "REPLY_HISTORY_TEST_DATABASE_URL"] as const) {
    const value = process.env[key];
    if (value === undefined || value.length === 0) continue;
    const url = new URL(value);
    url.pathname = `/gm_reply_history_test_${pool}`;
    process.env[key] = url.toString();
  }
}
