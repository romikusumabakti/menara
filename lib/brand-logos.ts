import { ACCENT_PALETTE } from "@/lib/accent-palette";
import type { AccentColor } from "@/lib/accents";

/** The name an instance shows until an admin (or the boot seed) sets one. */
export const DEFAULT_APP_NAME = "Menara";

/**
 * The built-in Menara mark, shown while the instance has no uploaded logo: a
 * watchtower of two tapered slabs under a round beacon, with a slit at the
 * 1:30 position that makes the beacon a clock dial too. One gap size runs
 * through the mark: between the slabs, between the beacon and the tower, and
 * the slit's width. The tower takes the accent's colour (--logo in the app,
 * ACCENT_PALETTE for the favicon); the beacon is always signal amber, and
 * breathes while runs are active (motion in web/styles.css).
 *
 * Geometry is drawn twice, each on a whole-pixel grid for the sizes it is shown
 * at, so no horizontal edge lands on half a pixel and blurs:
 *   - 24 units (gap 2) for the in-app logo, rendered at 24px;
 *   - 16 units (gap 1) for the favicon, shown at 16 and 32px.
 */

/** Tailwind amber-500: the beacon in every theme and accent. */
export const BEACON_COLOR = "#f59e0b";

type Grid = {
  /** Beacon centre and radius. */
  cx: number;
  cy: number;
  radius: number;
  gap: number;
  /** Slabs as [top, bottom], top to bottom; the taper spans all of them. */
  slabs: [number, number][];
  halfWidthTop: number;
  halfWidthBottom: number;
  corner: number;
};

const GRID_24: Grid = {
  cx: 12,
  cy: 4.5,
  radius: 4.5,
  gap: 2,
  slabs: [
    [11, 16],
    [18, 23],
  ],
  halfWidthTop: 5,
  halfWidthBottom: 7,
  corner: 1,
};

const GRID_16: Grid = {
  cx: 8,
  cy: 3,
  radius: 3,
  gap: 1,
  slabs: [
    [7, 11],
    [12, 16],
  ],
  halfWidthTop: 3.5,
  halfWidthBottom: 5,
  corner: 0.6,
};

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** A trapezoid centred on cx, its corners rounded by `corner`. */
function slabPath(
  cx: number,
  [top, bottom]: [number, number],
  halfTop: number,
  halfBottom: number,
  corner: number
): string {
  const points: [number, number][] = [
    [cx - halfTop, top],
    [cx + halfTop, top],
    [cx + halfBottom, bottom],
    [cx - halfBottom, bottom],
  ];
  const toward = ([ax, ay]: [number, number], [bx, by]: [number, number]) => {
    const d = Math.hypot(bx - ax, by - ay);
    return [ax + ((bx - ax) * corner) / d, ay + ((by - ay) * corner) / d];
  };
  return `${points
    .map((p, i) => {
      const prev = points[(i + 3) % 4] as [number, number];
      const next = points[(i + 1) % 4] as [number, number];
      const [sx, sy] = toward(p, prev) as [number, number];
      const [ex, ey] = toward(p, next) as [number, number];
      return `${i === 0 ? "M" : "L"}${n(sx)} ${n(sy)}Q${n(p[0])} ${n(p[1])} ${n(ex)} ${n(ey)}`;
    })
    .join("")}Z`;
}

/** The beacon: a disc with a slit from its centre out through the 1:30 edge. */
function beaconPath({ cx, cy, radius: r, gap }: Grid): string {
  const s = Math.SQRT1_2;
  const h = gap / 2;
  const t = Math.sqrt(r * r - h * h);
  // u points along the slit (up-right), v across it (down-right).
  const at = (along: number, across: number) =>
    `${n(cx + s * along + s * across)} ${n(cy - s * along + s * across)}`;
  return [
    `M${at(t, h)}`,
    `A${n(r)} ${n(r)} 0 1 1 ${at(t, -h)}`,
    `L${at(0, -h)}`,
    `A${n(h)} ${n(h)} 0 0 0 ${at(0, h)}`,
    "Z",
  ].join("");
}

type Shapes = { slabs: string[]; beacon: string };

function shapes(grid: Grid): Shapes {
  const first = grid.slabs[0]?.[0] ?? 0;
  const last = grid.slabs.at(-1)?.[1] ?? 0;
  const halfAt = (y: number) =>
    grid.halfWidthTop +
    ((y - first) * (grid.halfWidthBottom - grid.halfWidthTop)) / (last - first);
  return {
    slabs: grid.slabs.map((slab) =>
      slabPath(grid.cx, slab, halfAt(slab[0]), halfAt(slab[1]), grid.corner)
    ),
    beacon: beaconPath(grid),
  };
}

/** The in-app mark's shapes, on the 24-unit grid. */
export function logoShapes(): Shapes {
  return shapes(GRID_24);
}

type Colors = { fg: string };

const NEUTRAL_ICON: { light: Colors; dark: Colors } = {
  light: { fg: "#171717" },
  dark: { fg: "#fafafa" },
};

function iconColors(accent: AccentColor): { light: Colors; dark: Colors } {
  if (accent === "neutral") return NEUTRAL_ICON;
  const p = ACCENT_PALETTE[accent];
  return {
    light: { fg: p.logoLight },
    dark: { fg: p.logoDark },
  };
}

/** The favicon: static, on the 16-unit grid, coloured by the browser scheme. */
export function renderBrandIcon(accent: AccentColor): string {
  const { slabs, beacon } = shapes(GRID_16);
  const icon = iconColors(accent);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
    "<style>",
    `.f{fill:${icon.light.fg}}`,
    `@media (prefers-color-scheme: dark){.f{fill:${icon.dark.fg}}}`,
    "</style>",
    ...slabs.map((d) => `<path class="f" d="${d}"/>`),
    `<path fill="${BEACON_COLOR}" d="${beacon}"/>`,
    "</svg>",
  ].join("");
}

/**
 * The app icon (README, docs): the 24-unit mark in a dark rounded square, in
 * the brand's fixed colours. docs/images/menara-icon.svg is this output
 * (tests/brand-logos.test.ts keeps them equal).
 */
export function renderAppIcon(): string {
  const { slabs, beacon } = shapes(GRID_24);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    "<title>Menara</title>",
    '<rect width="32" height="32" rx="7" fill="#0d0f12"/>',
    '<g transform="translate(4 4)">',
    ...slabs.map((d) => `<path fill="#f4f4f0" d="${d}"/>`),
    `<path fill="${BEACON_COLOR}" d="${beacon}"/>`,
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}
