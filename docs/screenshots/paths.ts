// Files the screenshot run shares between its projects (all under the
// git-ignored e2e/.auth/).
export const CREDENTIALS = "e2e/.auth/screenshots.json";
export const STATE = "e2e/.auth/screenshots-state.json";
export const SESSION_ID = "e2e/.auth/screenshots-session-id";

// Who the screenshots are signed in as: the maintainer. AVATAR_HASH names the
// avatar URL the spec answers with avatar.jpg (the screenshot server has no
// object storage).
export const PROFILE = {
  name: "Romi Kusuma Bakti",
  preferredName: "Romi",
  email: "romi@rantara.com",
};
export const AVATAR_HASH = "5c4e0d1a9b7f3e21";
export const AVATAR_FILE = "docs/screenshots/avatar.jpg";
