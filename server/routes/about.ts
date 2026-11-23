import { MENARA_VERSION } from "@/lib/version";
import { sessionRouter } from "@/server/router";

// The About Menara dialog: which Menara release this instance runs. Behind a
// session so the sign-in page does not advertise the version.
export const aboutRouter = sessionRouter().get("/", (c) =>
  c.json({ version: MENARA_VERSION })
);
