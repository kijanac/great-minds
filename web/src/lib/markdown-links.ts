export type LinkDestination = {
  readonly kind: "web" | "email" | "fragment" | "wiki" | "raw";
  readonly href: string;
};

export type MarkdownLinkClick = (link: LinkDestination, event: MouseEvent) => void;

function parseUrl(value: unknown, base?: string): URL | undefined {
  if (typeof value !== "string") return;
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

const isWebUrl = (url: URL) => url.protocol === "https:" || url.protocol === "http:";

export function webHref(value: unknown): string | undefined {
  const url = parseUrl(value);
  return url && isWebUrl(url) ? url.href : undefined;
}

export function linkDestination(value: unknown): LinkDestination | undefined {
  if (typeof value !== "string") return;
  if (value.startsWith("#")) return { kind: "fragment", href: value };

  const kind = value.startsWith("wiki/") ? "wiki" : value.startsWith("raw/") ? "raw" : null;
  if (kind) {
    const [path] = value.split(/[?#]/, 1);
    if (path === `${kind}/` || parseUrl(value, "https://vault.invalid/")?.pathname !== `/${path}`)
      return;
    return { kind, href: value };
  }

  const url = parseUrl(value);
  if (!url) return;
  if (isWebUrl(url)) return { kind: "web", href: url.href };
  if (url.protocol === "mailto:") return { kind: "email", href: url.href };
}
