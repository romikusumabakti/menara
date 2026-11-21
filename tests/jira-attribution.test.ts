import { describe, expect, it } from "vitest";
import { adfToMarkdown, markdownToAdf } from "@/lib/jira/adf";
import {
  addAttribution,
  attributionLine,
  stripAttribution,
} from "@/lib/jira/attribution";

/**
 * The Jira connection authenticates as one person, so every comment Menara
 * pushes shows up in Jira under that account. The attribution line names the
 * real author on the way out and must vanish again on the way back in.
 */
describe("addAttribution", () => {
  it("prefixes the body with an italic author line", () => {
    expect(addAttribution("Fixed on staging.", "Jane Doe", "Menara")).toBe(
      "*Written by Jane Doe via Menara*\n\nFixed on staging."
    );
  });

  it("attribution uses the instance name", () => {
    expect(attributionLine("Jane Doe", "Acme Cloud")).toBe(
      "*Written by Jane Doe via Acme Cloud*\n\n"
    );
    expect(addAttribution("Hi.", "Jane Doe", "Acme Cloud")).toBe(
      "*Written by Jane Doe via Acme Cloud*\n\nHi."
    );
  });
});

describe("stripAttribution", () => {
  it("removes the line addAttribution added", () => {
    const body = "Fixed on staging.\n\n- step one";
    expect(stripAttribution(addAttribution(body, "Jane Doe", "Menara"))).toBe(
      body
    );
  });

  it("survives the Markdown -> ADF -> Markdown round trip through Jira", () => {
    const body = "Fixed on **staging**.";
    const roundTripped = adfToMarkdown(
      markdownToAdf(addAttribution(body, "John Roe", "Acme Cloud"))
    );
    expect(stripAttribution(roundTripped)).toBe(body);
  });

  it("removes the line older releases added", () => {
    // Comments pushed before the rename carry "via <Name> Panel".
    expect(
      stripAttribution("*Written by Jane Doe via Example Panel*\n\nFixed.")
    ).toBe("Fixed.");
  });

  it("strips any instance name", () => {
    for (const name of ["Menara", "Acme Cloud", "oldtool-beta", "Kestrel QA"]) {
      expect(
        stripAttribution(`*Written by Jane Doe via ${name}*\n\nFixed.`)
      ).toBe("Fixed.");
    }
  });

  it("leaves a comment written in Jira untouched", () => {
    expect(stripAttribution("Looks good to me.")).toBe("Looks good to me.");
  });

  it("only strips the line at the very start", () => {
    const body = "Quote:\n\n*Written by Someone via Menara*";
    expect(stripAttribution(body)).toBe(body);
  });
});
