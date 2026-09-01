import { API_BASE } from "./base-url";
import { makeApi } from "./runtime";
import { TokenStoreLive } from "./token-store";

export const { api, http, run, stream } = makeApi({
  baseUrl: API_BASE,
  fetch: (input, init) => fetch(input, init),
  tokens: TokenStoreLive,
});
