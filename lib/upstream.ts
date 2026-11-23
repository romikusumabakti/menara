// Where Menara itself lives: the open-source upstream repository. Client-safe
// (no server-only imports), so the About dialog and the public footer link
// here as well as the server.
import { parseVersion } from "@/lib/version";

export const UPSTREAM_REPO_URL = "https://github.com/romikusumabakti/menara";

export const UPSTREAM_ISSUES_URL = `${UPSTREAM_REPO_URL}/issues`;

/**
 * The release notes of `version` on GitHub Releases, or the release list for
 * a build that is not a release (`0.0.0-dev`).
 */
export function releaseNotesUrl(version: string): string {
  return parseVersion(version)
    ? `${UPSTREAM_REPO_URL}/releases/tag/v${version}`
    : `${UPSTREAM_REPO_URL}/releases`;
}
