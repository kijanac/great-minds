import { lookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";
import {
  Agent,
  buildConnector,
  fetch,
  type RequestInit as FetchRequestInit,
  type Response as FetchResponse,
} from "undici";

// SSRF guard for fetching user-supplied URLs: addresses are validated at
// socket-connect time, so every redirect hop is covered and a DNS answer
// cannot change between validation and connection.
const isPublicAddress = (address: string) => {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
};

const blockedAddress = (hostname: string) =>
  new Error(`Refusing to connect to non-public address of host "${hostname}"`);

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, options, (error, address, family) => {
    if (error === null) {
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      if (!addresses.every(isPublicAddress)) {
        callback(blockedAddress(hostname), address, family);
        return;
      }
    }
    callback(error, address, family);
  });
};

const connectValidated = buildConnector({ lookup: guardedLookup });

// Literal-IP hosts never reach DNS lookup, so they are checked here.
const guardedConnect: buildConnector.connector = (options, callback) => {
  const hostname = options.hostname.startsWith("[")
    ? options.hostname.slice(1, -1)
    : options.hostname;
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
    callback(blockedAddress(hostname), null);
    return;
  }
  connectValidated(options, callback);
};

const publicInternetAgent = new Agent({ connect: guardedConnect });

export const fetchPublicUrl = (url: string, init?: Omit<FetchRequestInit, "dispatcher">) =>
  fetch(url, { ...init, dispatcher: publicInternetAgent });

// Escape hatch for loopback fixtures (ALLOW_PRIVATE_URL_FETCH); production URL
// ingest must go through fetchPublicUrl.
export const fetchAnyUrl = (url: string, init?: Omit<FetchRequestInit, "dispatcher">) =>
  fetch(url, init);

export const responseTextCapped = async (response: FetchResponse, maxBytes: number) => {
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > maxBytes) {
      throw new Error(`Response body exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
};
