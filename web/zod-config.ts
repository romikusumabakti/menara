import { z } from "zod";

// Zod compiles object parsers with `new Function`. The page's
// Content-Security-Policy (server/middleware/security-headers.ts) forbids
// eval, so the probe would be reported as a violation even though Zod catches
// the failure. `jitless` skips the probe and uses the interpreted parsers.
//
// It must run before any schema is built. Imported first in main.tsx, and
// vite.config.ts bundles it into Zod's own chunk: chunking does not keep the
// entry's import order, so that is what makes it run before other chunks
// build their schemas.
z.config({ jitless: true });
