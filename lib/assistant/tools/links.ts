/**
 * Links the assistant tools hand to the model for people and projects. They
 * are absolute on the instance's public URL (the same base lib/auth.ts uses)
 * so MCP clients get usable links; the web renderer maps same-origin ones to
 * the profile hover card and in-app links.
 */

export function instanceOrigin(): string {
  return new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
}

export type PersonRef = { name: string; profileUrl: string };
export type ProjectRef = { key: string; name: string; url: string };

export function personRef(p: { id: string; name: string }): PersonRef {
  return {
    name: p.name,
    profileUrl: `${instanceOrigin()}/people/${encodeURIComponent(p.id)}`,
  };
}

export function projectRef(p: { key: string; name: string }): ProjectRef {
  return {
    key: p.key,
    name: p.name,
    url: `${instanceOrigin()}/${encodeURIComponent(p.key)}`,
  };
}
