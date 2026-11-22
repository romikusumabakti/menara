import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type AccentColor, isAccent } from "@/lib/accents";
import { renderBrandIcon } from "@/lib/brand-logos";
import {
  getBranding,
  getBrandLogoBytes,
  type InstanceBranding,
} from "@/lib/instance-branding";
import type { AppEnv } from "@/server/context";
import { publicRouter } from "@/server/router";

/**
 * The instance logo and favicon. Public: the sign-in, 404 and error pages
 * show them too. A stored logo is an admin upload (SVG sanitized on upload,
 * raster re-encoded), served from the app's origin, so every answer here also
 * carries a sandbox CSP and nosniff: even opened directly, nothing in it runs
 * or loads. Responses revalidate (no-cache) against an ETag that names the
 * branding version, so a new logo shows on the next load.
 */

const BRAND_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "public, no-cache",
};

const brandHeaders = createMiddleware(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(BRAND_HEADERS)) {
    c.res.headers.set(name, value);
  }
});

const SVG = "image/svg+xml";

/** True when If-None-Match lists `etag` (weak or strong) or is `*`. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

type Answer =
  | { kind: "stored"; theme: "light" | "dark"; etag: string }
  | { kind: "default"; accent: AccentColor; etag: string };

const stored = (b: InstanceBranding, theme: "light" | "dark"): Answer => ({
  kind: "stored",
  theme,
  etag: `"${b.version}-${theme}"`,
});

// The built-in mark's SVG per accent, with an ETag hashed from the bytes, so
// a change to the renderer (lib/brand-logos.ts) gives browsers a new tag.
const marks = new Map<AccentColor, { svg: string; etag: string }>();

function renderedMark(accent: AccentColor): { svg: string; etag: string } {
  let mark = marks.get(accent);
  if (!mark) {
    const svg = renderBrandIcon(accent);
    mark = { svg, etag: `"default-${accent}-${Bun.hash(svg).toString(36)}"` };
    marks.set(accent, mark);
  }
  return mark;
}

const defaultMark = (accent: AccentColor): Answer => ({
  kind: "default",
  accent,
  etag: renderedMark(accent).etag,
});

// The favicon PNG for a raster logo, resized once per branding version.
let iconPng: { version: string; bytes: Uint8Array } | null = null;

// A browser may draw an SVG favicon once, at its first frame (Firefox does),
// so a logo whose shapes animate in would be a blank tab icon. The favicon
// turns CSS animation off and shows the logo as it ends; the sanitizer
// already drops SMIL. A <style> applies to the whole document wherever it sits, so it goes
// just before the last </svg> (the root's), which is easier to find safely
// than the end of the root's opening tag.
const STILL =
  "<style>*{animation:none!important;transition:none!important}</style>";

function stillSvg(bytes: Uint8Array): string {
  const svg = new TextDecoder().decode(bytes);
  const end = svg.lastIndexOf("</svg>");
  return end === -1 ? svg : `${svg.slice(0, end)}${STILL}${svg.slice(end)}`;
}

const ICON_SIZE = 64;

const iconRaster = (bytes: Uint8Array) =>
  new Bun.Image(bytes).resize(ICON_SIZE, ICON_SIZE).png().bytes();

/** One theme's logo as a favicon data URI: a still SVG, or a 64px PNG. */
async function iconDataUri(logo: {
  bytes: Uint8Array;
  type: string;
}): Promise<string> {
  const [type, bytes] =
    logo.type === SVG
      ? [SVG, Buffer.from(stillSvg(logo.bytes))]
      : ["image/png", Buffer.from(await iconRaster(logo.bytes))];
  return `data:${type};base64,${bytes.toString("base64")}`;
}

// With a dark logo, the favicon holds both and lets the browser's colour
// scheme pick, as the built-in mark does: a favicon can't see the app theme.
// Data URIs keep the two documents apart (both may use the same class names),
// and an image may load them under the sandbox CSP.
async function pairedIcon(
  light: { bytes: Uint8Array; type: string },
  dark: { bytes: Uint8Array; type: string }
): Promise<string> {
  const image = async (slot: string, logo: typeof light) =>
    `<image class="${slot}" width="${ICON_SIZE}" height="${ICON_SIZE}" href="${await iconDataUri(logo)}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">`,
    "<style>.d{display:none}@media (prefers-color-scheme:dark){.l{display:none}.d{display:inline}}</style>",
    await image("l", light),
    await image("d", dark),
    "</svg>",
  ].join("");
}

export const brandRouter = publicRouter()
  .use(brandHeaders)
  .get("/logo", async (c) => {
    const branding = await getBranding();
    const wantDark = c.req.query("theme") === "dark";
    const answer =
      wantDark && branding.logoDark
        ? stored(branding, "dark")
        : branding.logo
          ? stored(branding, "light")
          : defaultMark(branding.accent);
    return serve(c, answer);
  })
  // The favicon. The root layout links it with the user's `?accent=`, which
  // only tints the default mark; a custom logo is shown as uploaded, still.
  .get("/icon.svg", async (c) => {
    const branding = await getBranding();
    if (branding.logo?.type === SVG || branding.logoDark) {
      const etag = `"${branding.version}-icon"`;
      if (matches(c.req.header("If-None-Match"), etag)) {
        return c.body(null, 304, { ETag: etag });
      }
      const [light, dark] = await Promise.all([
        getBrandLogoBytes("light"),
        branding.logoDark ? getBrandLogoBytes("dark") : null,
      ]);
      if (!light) return c.json({ error: "Not Found" }, 404);
      let svg: string;
      if (dark) svg = await pairedIcon(light, dark);
      else if (light.type === SVG) svg = stillSvg(light.bytes);
      else return c.redirect("/brand/icon.png", 302);
      return c.body(svg, 200, { "Content-Type": SVG, ETag: etag });
    }
    if (branding.logo) return c.redirect("/brand/icon.png", 302);
    const param = c.req.query("accent");
    return serve(c, defaultMark(isAccent(param) ? param : branding.accent));
  })
  .get("/icon.png", async (c) => {
    const branding = await getBranding();
    if (!branding.logo || branding.logo.type === SVG) {
      return c.json({ error: "Not Found" }, 404);
    }
    const etag = `"${branding.version}-icon"`;
    if (matches(c.req.header("If-None-Match"), etag)) {
      return c.body(null, 304, { ETag: etag });
    }
    if (iconPng?.version !== branding.version) {
      const logo = await getBrandLogoBytes("light");
      if (!logo || logo.type === SVG)
        return c.json({ error: "Not Found" }, 404);
      iconPng = {
        version: branding.version,
        bytes: await iconRaster(logo.bytes),
      };
    }
    return c.body(iconPng.bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "image/png",
      ETag: etag,
    });
  });

async function serve(c: Context<AppEnv>, answer: Answer) {
  if (matches(c.req.header("If-None-Match"), answer.etag)) {
    return c.body(null, 304, { ETag: answer.etag });
  }
  if (answer.kind === "default") {
    return c.body(renderedMark(answer.accent).svg, 200, {
      "Content-Type": SVG,
      ETag: answer.etag,
    });
  }
  const logo = await getBrandLogoBytes(answer.theme);
  if (!logo) return c.json({ error: "Not Found" }, 404);
  return c.body(logo.bytes as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": logo.type,
    ETag: answer.etag,
  });
}
