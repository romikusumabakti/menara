import { locales } from "@/i18n/locales";

/** Where a markdown link points, as the renderer treats it. */
export type MarkdownLink =
  | { kind: "person"; id: string }
  | { kind: "app"; path: string }
  | { kind: "external"; href: string };

const LOCALE_PREFIX = new RegExp(`^/(?:${locales.join("|")})(?=/|$)`);
const PERSON_PATH =
  /^\/people\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * Classifies a link in rendered markdown: a profile on this instance
 * (relative, or absolute on `origin`) is a person, any other path on this
 * instance (except `/api/…` endpoints) an in-app path without its locale
 * prefix (the locale-aware Link adds the current one), and everything else (other origins,
 * protocol-relative URLs, mailto:, …) external.
 */
export function classifyLink(href: string, origin: string): MarkdownLink {
  const external: MarkdownLink = { kind: "external", href };
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return external;
  }
  const relative = href.startsWith("/") && !href.startsWith("//");
  if (!relative && url.origin !== origin) return external;
  const pathname = url.pathname.replace(LOCALE_PREFIX, "") || "/";
  // Server endpoints (attachments, downloads) are not app routes.
  if (pathname === "/api" || pathname.startsWith("/api/")) return external;
  const id = PERSON_PATH.exec(pathname)?.[1];
  if (id && !url.search && !url.hash) return { kind: "person", id };
  return { kind: "app", path: `${pathname}${url.search}${url.hash}` };
}
