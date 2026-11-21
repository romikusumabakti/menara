/**
 * The Jira connection authenticates as a single account, so Jira shows every
 * comment Menara pushes as written by that account. The real author goes in a
 * fixed first paragraph instead, and the pull side strips it again so the
 * Menara copy keeps its original body.
 *
 * The wording is fixed (not localized) because the pull side recognizes it by
 * shape. The name after "via" is the instance name (Admin > Instance >
 * Branding), and any name is stripped so comments pushed under an earlier
 * instance name or by older releases ("via <Name> Panel") are still recognized.
 */
const ATTRIBUTION_PATTERN = /^\*Written by .+ via [^*\n]+\*\n\n/;

/** The first paragraph naming the real author; `instanceName` is the branding name. */
export function attributionLine(
  authorName: string,
  instanceName: string
): string {
  return `*Written by ${authorName} via ${instanceName}*\n\n`;
}

export function addAttribution(
  body: string,
  authorName: string,
  instanceName: string
): string {
  return `${attributionLine(authorName, instanceName)}${body}`;
}

export function stripAttribution(body: string): string {
  return body.replace(ATTRIBUTION_PATTERN, "");
}
