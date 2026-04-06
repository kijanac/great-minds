const API_BASE = "/api"

function getAccessToken(): string | null {
  return localStorage.getItem("access_token")
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refresh_token")
}

function storeTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("access_token", accessToken)
  localStorage.setItem("refresh_token", refreshToken)
}

export function clearTokens() {
  localStorage.removeItem("access_token")
  localStorage.removeItem("refresh_token")
}

async function refreshAccessToken(): Promise<string | null> {
  const rt = getRefreshToken()
  if (!rt) return null

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  })

  if (!res.ok) {
    clearTokens()
    return null
  }

  const data: { access_token: string; refresh_token: string } =
    await res.json()
  storeTokens(data.access_token, data.refresh_token)
  return data.access_token
}

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = getAccessToken()
  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  let res = await fetch(input, { ...init, headers })

  if (res.status === 401) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`)
      res = await fetch(input, { ...init, headers })
    }
  }

  return res
}

export async function loginWithCode(
  email: string,
  code: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch(`${API_BASE}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  })
  if (!res.ok) throw new Error("Invalid or expired code")

  const data: { access_token: string; refresh_token: string } =
    await res.json()
  storeTokens(data.access_token, data.refresh_token)
  return data
}

export async function requestCode(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw new Error("Failed to send code")
}
