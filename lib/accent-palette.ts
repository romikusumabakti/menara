import type { AccentColor } from "@/lib/accents";

export type TintedAccent = Exclude<AccentColor, "neutral">;
type Steps = {
  logoLight: number;
  logoDark: number;
  ringLight: number;
  ringDark: number;
};

export type LogoStep = "logoLight" | "logoDark";

/**
 * Tailwind steps per accent for the logo and focus ring. Logo: 900 light, 200
 * dark. Ring: 500 light and 400 dark, except where that falls below 3:1
 * against the page background (WCAG 1.4.11): orange through sky use 600,
 * yellow 700. web/styles.css binds the same steps; tests/accent-theme.test.ts
 * checks both agree.
 */
export const ACCENT_STEPS: Record<TintedAccent, Steps> = {
  red: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  orange: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  amber: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  yellow: { logoLight: 900, logoDark: 200, ringLight: 700, ringDark: 400 },
  lime: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  green: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  emerald: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  teal: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  cyan: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  sky: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  blue: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  indigo: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  violet: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  purple: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  fuchsia: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  pink: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  rose: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
};

/**
 * The oklch values of the logo steps, copied from tailwindcss/theme.css for
 * the favicon's tower (which cannot read the page's CSS variables). Kept in
 * sync by tests/accent-palette.test.ts.
 */
export const ACCENT_PALETTE: Record<TintedAccent, Record<LogoStep, string>> = {
  red: {
    logoLight: "oklch(39.6% 0.141 25.723)",
    logoDark: "oklch(88.5% 0.062 18.334)",
  },
  orange: {
    logoLight: "oklch(40.8% 0.123 38.172)",
    logoDark: "oklch(90.1% 0.076 70.697)",
  },
  amber: {
    logoLight: "oklch(41.4% 0.112 45.904)",
    logoDark: "oklch(92.4% 0.12 95.746)",
  },
  yellow: {
    logoLight: "oklch(42.1% 0.095 57.708)",
    logoDark: "oklch(94.5% 0.129 101.54)",
  },
  lime: {
    logoLight: "oklch(40.5% 0.101 131.063)",
    logoDark: "oklch(93.8% 0.127 124.321)",
  },
  green: {
    logoLight: "oklch(39.3% 0.095 152.535)",
    logoDark: "oklch(92.5% 0.084 155.995)",
  },
  emerald: {
    logoLight: "oklch(37.8% 0.077 168.94)",
    logoDark: "oklch(90.5% 0.093 164.15)",
  },
  teal: {
    logoLight: "oklch(38.6% 0.063 188.416)",
    logoDark: "oklch(91% 0.096 180.426)",
  },
  cyan: {
    logoLight: "oklch(39.8% 0.07 227.392)",
    logoDark: "oklch(91.7% 0.08 205.041)",
  },
  sky: {
    logoLight: "oklch(39.1% 0.09 240.876)",
    logoDark: "oklch(90.1% 0.058 230.902)",
  },
  blue: {
    logoLight: "oklch(37.9% 0.146 265.522)",
    logoDark: "oklch(88.2% 0.059 254.128)",
  },
  indigo: {
    logoLight: "oklch(35.9% 0.144 278.697)",
    logoDark: "oklch(87% 0.065 274.039)",
  },
  violet: {
    logoLight: "oklch(38% 0.189 293.745)",
    logoDark: "oklch(89.4% 0.057 293.283)",
  },
  purple: {
    logoLight: "oklch(38.1% 0.176 304.987)",
    logoDark: "oklch(90.2% 0.063 306.703)",
  },
  fuchsia: {
    logoLight: "oklch(40.1% 0.17 325.612)",
    logoDark: "oklch(90.3% 0.076 319.62)",
  },
  pink: {
    logoLight: "oklch(40.8% 0.153 2.432)",
    logoDark: "oklch(89.9% 0.061 343.231)",
  },
  rose: {
    logoLight: "oklch(41% 0.159 10.272)",
    logoDark: "oklch(89.2% 0.058 10.001)",
  },
};
