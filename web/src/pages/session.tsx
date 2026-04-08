import { useParams, Navigate } from "react-router";

import { HomeContainer } from "@/containers/home-container";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();

  if (!id) return <Navigate to="/" replace />;

  return <HomeContainer sessionId={id} />;
}
