export function tokenResponse(tokenPair: { accessToken: string; refreshToken: string }) {
  return {
    access_token: tokenPair.accessToken,
    refresh_token: tokenPair.refreshToken,
    token_type: "bearer",
  };
}

