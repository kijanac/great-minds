import type { LoaderFunctionArgs } from "react-router";

import { readDocument } from "@/api/doc";

export async function docLoader({ params, request }: LoaderFunctionArgs) {
  const path = params["*"];
  if (!path) return null;

  try {
    return await readDocument(path, request.signal);
  } catch {
    return null;
  }
}
