import { useRef } from "react"
import { useSearchParams } from "react-router"

import { HomeContainer } from "@/containers/home-container"

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const consumed = useRef(false)

  // Read params once, then clear them to prevent re-submission on back-nav
  const initialQuery = useRef(searchParams.get("q") ?? undefined).current
  const origin = useRef(searchParams.get("origin") ?? undefined).current
  if ((initialQuery || origin) && !consumed.current) {
    consumed.current = true
    setSearchParams({}, { replace: true })
  }

  return (
    <HomeContainer
      initialQuery={initialQuery}
      origin={origin}
    />
  )
}
