import { API_BASE } from "./base-url";
import { makeApi } from "@great-minds/client";
import { TokenStoreLive } from "./token-store";

export const connection = makeApi({
  baseUrl: API_BASE,
  fetch: (input, init) => fetch(input, init),
  tokens: TokenStoreLive,
});

export const { api, run, fork, stream } = connection;
