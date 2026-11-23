import { DrizzleQueryError } from "drizzle-orm/errors";

/**
 * What a log line may say about an unexpected error: its class, its code and
 * its message, never the error object (whose properties a logger prints). A
 * failed Drizzle query names only its cause: the query error's own message
 * lists the bound parameters, which are tool input.
 */
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  if (error instanceof DrizzleQueryError) {
    return `${error.name}: ${errorSummary(error.cause)}`;
  }
  const code = (error as { code?: unknown }).code;
  const tag =
    typeof code === "string" || typeof code === "number" ? ` [${code}]` : "";
  return `${error.name}${tag}: ${error.message}`;
}
