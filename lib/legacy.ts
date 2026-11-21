/**
 * Transition configuration: lets a migrated install recognise data written
 * under the product's previous name. Every legacy form is derived from
 * `MENARA_LEGACY_NAME`; when it is unset every transition path is off and the
 * instance behaves like a fresh install.
 */

export type Legacy = {
  /** Lowercase name, `[a-z][a-z0-9-]*`. */
  name: string;
  /** Uppercase with `-` replaced by `_` (env prefix). */
  upper: string;
  /** First letter uppercase. */
  title: string;
  /** Previous instance name from `MENARA_LEGACY_INSTANCE`; callers fall back to `name`. */
  instance: string | null;
};

const NAME_RE = /^[a-z][a-z0-9-]*$/;

let warnedInvalid = false;

export function legacy(env: NodeJS.ProcessEnv = process.env): Legacy | null {
  const name = env.MENARA_LEGACY_NAME?.trim();
  if (!name) return null;
  if (!NAME_RE.test(name)) {
    if (!warnedInvalid) {
      warnedInvalid = true;
      console.warn(
        "[legacy] MENARA_LEGACY_NAME must match [a-z][a-z0-9-]*; transition support is off"
      );
    }
    return null;
  }
  return {
    name,
    upper: name.toUpperCase().replaceAll("-", "_"),
    title: name.charAt(0).toUpperCase() + name.slice(1),
    instance: env.MENARA_LEGACY_INSTANCE?.trim() || null,
  };
}

/** Case-insensitive match of the legacy name as a whole word (letters/digits on neither side). */
export function legacyPattern(l: Legacy): RegExp {
  const escaped = l.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

/**
 * Copy `<UPPER>_<X>` to `MENARA_<X>` for every key whose target is unset.
 * Returns the keys copied so the caller can log one warning.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const l = legacy(env);
  if (!l) return [];
  const prefix = `${l.upper}_`;
  const copied: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;
    const target = `MENARA_${key.slice(prefix.length)}`;
    if (target === "MENARA_" || env[target] !== undefined) continue;
    env[target] = value;
    copied.push(target);
  }
  return copied;
}

/** Apply the legacy env fallback and log one warning listing copied keys. */
export function applyLegacyEnvAndWarn(env: NodeJS.ProcessEnv): void {
  const copied = applyLegacyEnv(env);
  if (copied.length > 0) {
    console.warn(
      `[legacy] using previous-name env vars for: ${copied.join(", ")}. Rename them to MENARA_*.`
    );
  }
}
