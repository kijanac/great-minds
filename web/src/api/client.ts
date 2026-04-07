const API_BASE = import.meta.env.VITE_API_BASE || "/api"

function getAccessToken(): string | null {
  return localStorage.getItem("access_token")
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refresh_token")
}

function getBrainId(): string | null {
  return localStorage.getItem("brain_id")
}

function storeTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("access_token", accessToken)
  localStorage.setItem("refresh_token", refreshToken)
}

function storeBrainId(brainId: string) {
  localStorage.setItem("brain_id", brainId)
}

export function clearTokens() {
  localStorage.removeItem("access_token")
  localStorage.removeItem("refresh_token")
  localStorage.removeItem("brain_id")
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

async function resolvePersonalBrain(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/brains`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error("Failed to fetch brains")

  const brains: { id: string; kind: string }[] = await res.json()
  const personal = brains.find((b) => b.kind === "PERSONAL")
  if (!personal) throw new Error("No personal brain found")
  return personal.id
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(`${API_BASE}${path}`, location.origin)
  const brainId = getBrainId()
  if (brainId) url.searchParams.set("brain_id", brainId)

  const headers = new Headers(init?.headers)
  const token = getAccessToken()
  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  let res = await fetch(url, { ...init, headers })

  if (res.status === 401) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`)
      res = await fetch(url, { ...init, headers })
    }
  }

  return res
}

export async function ensureBrainId(): Promise<void> {
  if (getBrainId()) return
  const token = getAccessToken()
  if (!token) return
  const brainId = await resolvePersonalBrain(token)
  storeBrainId(brainId)
}

export async function loginWithCode(
  email: string,
  code: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  })
  if (!res.ok) throw new Error("Invalid or expired code")

  const data: { access_token: string; refresh_token: string } =
    await res.json()
  storeTokens(data.access_token, data.refresh_token)

  try {
    const brainId = await resolvePersonalBrain(data.access_token)
    storeBrainId(brainId)
  } catch {
    throw new Error("Signed in, but failed to load your workspace. Please refresh.")
  }
}

export async function requestCode(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw new Error("Failed to send code")
}
