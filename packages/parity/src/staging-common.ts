import type { CapturedResponse } from "./http.ts";

export const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const PROD_HOST_PATTERNS = [/\.onrender\.com$/i, /(^|\.)greatmind\.dev$/i];

export const refuseProdTarget = (value: string, label: string) => {
  const host = (() => {
    try {
      return new URL(value.includes("://") ? value : `scheme://${value}`).hostname;
    } catch {
      return value;
    }
  })();
  if (PROD_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(
      `${label} points at a production host (${host}); the staging tools refuse to run against production`,
    );
  }
  return value;
};

export const baseUrl = (name: string) =>
  refuseProdTarget(requiredEnv(name).replace(/\/+$/, ""), name);

export const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const asArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
};

export const asString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const responseRecord = (response: CapturedResponse, label: string) => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return asRecord(response.body, `${label} response`);
};

export const encodeDocumentPath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));
