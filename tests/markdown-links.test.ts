import { describe, expect, it } from "vitest";
import { classifyLink } from "@/lib/markdown-links";

const ORIGIN = "https://panel.example.com";
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("classifyLink", () => {
  it("maps relative and same-origin profile links to a person", () => {
    expect(classifyLink(`/people/${ID}`, ORIGIN)).toEqual({
      kind: "person",
      id: ID,
    });
    expect(classifyLink(`${ORIGIN}/people/${ID}`, ORIGIN)).toEqual({
      kind: "person",
      id: ID,
    });
    expect(classifyLink(`/id/people/${ID}`, ORIGIN)).toEqual({
      kind: "person",
      id: ID,
    });
  });

  it("maps other in-app paths to an app link without the locale", () => {
    expect(classifyLink("/ACME", ORIGIN)).toEqual({
      kind: "app",
      path: "/ACME",
    });
    expect(classifyLink("/en/ACME/dev", ORIGIN)).toEqual({
      kind: "app",
      path: "/ACME/dev",
    });
    expect(classifyLink(`${ORIGIN}/knowledge/setup`, ORIGIN)).toEqual({
      kind: "app",
      path: "/knowledge/setup",
    });
    expect(classifyLink("/people/not-a-uuid", ORIGIN)).toEqual({
      kind: "app",
      path: "/people/not-a-uuid",
    });
    expect(classifyLink("/ACME/issues?state=open#top", ORIGIN)).toEqual({
      kind: "app",
      path: "/ACME/issues?state=open#top",
    });
  });

  it("treats other origins and protocol-relative links as external", () => {
    expect(classifyLink("https://other.example.com/people/x", ORIGIN)).toEqual({
      kind: "external",
      href: "https://other.example.com/people/x",
    });
    expect(classifyLink("//other.example.com/ACME", ORIGIN)).toEqual({
      kind: "external",
      href: "//other.example.com/ACME",
    });
    // Server endpoints (attachments, downloads) are not app routes.
    expect(classifyLink("/api/knowledge/asset/1", ORIGIN)).toEqual({
      kind: "external",
      href: "/api/knowledge/asset/1",
    });
    expect(classifyLink("mailto:ana@example.com", ORIGIN)).toEqual({
      kind: "external",
      href: "mailto:ana@example.com",
    });
  });
});
