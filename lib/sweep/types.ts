/**
 * One trace of the previous product name left in a system, or a system the
 * sweep could not check (`excerpt` then starts with "could not check"). Never
 * carries a secret: excerpts come from remark plans and non-secret text
 * columns.
 */
export type SweepHit = {
  system: string;
  location: string;
  excerpt: string;
};

export type SweepReport = {
  hits: SweepHit[];
  /** True when anything is left or could not be checked. */
  failed: boolean;
};

export const EXCERPT_MAX = 120;

/** Whitespace runs read as one space; cut to EXCERPT_MAX with an ellipsis. */
export function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX)}…` : flat;
}
