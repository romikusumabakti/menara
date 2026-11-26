import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown>[] = [];
let racingWinner: Record<string, unknown> | null = null;

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (column: { name: string }, value: unknown) => ({
    column: column.name,
    value,
  }),
}));

// Minimal in-memory stand-in for the ssh_keys table: filters by the eq()
// condition and honours the "one current row" unique index.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { column: string; value: unknown }) => ({
          limit: async () =>
            rows.filter((r) => r[cond.column] === cond.value).slice(0, 1),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (racingWinner) {
              // Another process wins between our select and insert.
              rows.push(racingWinner);
              return [];
            }
            if (rows.some((r) => r.status === "current")) return [];
            const row = {
              id: `key-${rows.length + 1}`,
              status: "current",
              ...v,
            };
            rows.push(row);
            return [row];
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/secrets", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

import {
  authorizedKeysLine,
  dropOtherInstanceKeys,
  ensureCurrentKey,
  fromAddress,
  fromOfLine,
  generateInstanceKey,
  isOurs,
  isValidFrom,
  keyMarker,
  legacyKeyMarker,
  loadPrivateKey,
  mergeAuthorizedKeys,
  removeAuthorizedKey,
} from "@/lib/ssh-keys";

const MARKER = "menara:menara:K";
const OURS = authorizedKeysLine("ssh-ed25519 AAAA x", "10.0.0.1", MARKER);

beforeEach(() => {
  rows.length = 0;
  racingWinner = null;
  vi.unstubAllEnvs();
});

describe("generateInstanceKey", () => {
  it("skips a generated private key that does not parse", () => {
    const real = ssh2.utils.generateKeyPairSync;
    // ssh2 occasionally generates an ed25519 key its own parser rejects
    // (that is what generateInstanceKey retries around), so the "good" key
    // must itself be one that parses — otherwise the code under test
    // rightly skips it too and returns a third, unrelated key.
    let good = real("ed25519");
    while (ssh2.utils.parseKey(good.private) instanceof Error) {
      good = real("ed25519");
    }
    const spy = vi
      .spyOn(ssh2.utils, "generateKeyPairSync")
      .mockReturnValueOnce({
        public: good.public,
        private:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
      })
      .mockReturnValueOnce(good);
    try {
      expect(generateInstanceKey().privateKeyPem).toBe(good.private);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("generates an ed25519 key", () => {
    const k = generateInstanceKey();
    expect(k.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(k.privateKeyPem).toContain("BEGIN OPENSSH PRIVATE KEY");

    let out: string | null = null;
    const dir = mkdtempSync(join(tmpdir(), "ssh-keys-test-"));
    try {
      const pub = join(dir, "k.pub");
      writeFileSync(pub, `${k.publicKey}\n`);
      out = execFileSync("ssh-keygen", ["-lf", pub], { encoding: "utf8" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      console.warn(
        "ssh-keygen not available; skipping fingerprint cross-check"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (out) expect(out.split(/\s+/)[1]).toBe(k.fingerprint);
  });
});

describe("authorized_keys helpers", () => {
  it("line format", () => {
    expect(
      authorizedKeysLine("ssh-ed25519 AAAA x", "192.168.10.113", MARKER)
    ).toBe(
      `from="192.168.10.113",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA ${MARKER}`
    );
  });

  it("merge keeps foreign lines", () => {
    const existing =
      "# comment\nssh-rsa AAAAB3 alice@x\n\nssh-ed25519 BBBB bob\n";
    expect(mergeAuthorizedKeys(existing, OURS, MARKER)).toBe(
      `${existing}${OURS}\n`
    );
  });

  it("replaces same marker", () => {
    const old = authorizedKeysLine("ssh-ed25519 OLD x", "1.1.1.1", MARKER);
    const existing = `ssh-rsa A a\n${old}\nssh-rsa B b\n`;
    expect(mergeAuthorizedKeys(existing, OURS, MARKER)).toBe(
      `ssh-rsa A a\n${OURS}\nssh-rsa B b\n`
    );
  });

  it("handles CRLF and no newline", () => {
    expect(
      mergeAuthorizedKeys("ssh-rsa A a\r\nssh-rsa B b", OURS, MARKER)
    ).toBe(`ssh-rsa A a\r\nssh-rsa B b\n${OURS}\n`);
    expect(mergeAuthorizedKeys("", OURS, MARKER)).toBe(`${OURS}\n`);
    expect(
      mergeAuthorizedKeys(`ssh-rsa A a\r\n${OURS}\r\n`, OURS, MARKER)
    ).toBe(`ssh-rsa A a\r\n${OURS}\n`);
  });

  it("collapses duplicate marker lines and ignores comments", () => {
    const existing = `# ${MARKER}\n${OURS}\nssh-rsa A a\n${OURS}\n`;
    expect(mergeAuthorizedKeys(existing, OURS, MARKER)).toBe(
      `# ${MARKER}\n${OURS}\nssh-rsa A a\n`
    );
    expect(removeAuthorizedKey(existing, MARKER)).toBe(
      `# ${MARKER}\nssh-rsa A a\n`
    );
  });

  it("remove drops only our marker line", () => {
    const existing = `ssh-rsa A a\n${OURS}\nssh-rsa B menara:menara:K2\n`;
    expect(removeAuthorizedKey(existing, MARKER)).toBe(
      "ssh-rsa A a\nssh-rsa B menara:menara:K2\n"
    );
  });
});

describe("authorizedKeysLine validation", () => {
  const KEY = "ssh-ed25519 AAAA x";
  it("accepts IPs and CIDRs", () => {
    expect(authorizedKeysLine(KEY, "10.0.0.0/8", MARKER)).toContain(
      'from="10.0.0.0/8"'
    );
    expect(authorizedKeysLine(KEY, "::1", MARKER)).toContain('from="::1"');
    expect(authorizedKeysLine(KEY, "fd00::/64", MARKER)).toContain(
      'from="fd00::/64"'
    );
  });

  it.each([
    '1.2.3.4",command="id',
    "1.2.3.4,command=id",
    "1.2.3.4 x",
    "",
    "not-an-ip",
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0.0/",
    "10.0.0.0/8/8",
    "fe80::1%eth0",
    "fe80::/64%eth0",
    // Wider than normaliseSubnet allows: no restriction worth the name.
    "0.0.0.0/0",
    "10.0.0.0/7",
    "::/0",
    "fd00::/31",
  ])("rejects from=%j", (from) => {
    expect(() => authorizedKeysLine(KEY, from, MARKER)).toThrow();
  });

  it("rejects non-ed25519 keys, empty blobs, and bad markers", () => {
    expect(() =>
      authorizedKeysLine("ssh-rsa AAAA x", "1.2.3.4", MARKER)
    ).toThrow();
    expect(() =>
      authorizedKeysLine("ssh-ed25519", "1.2.3.4", MARKER)
    ).toThrow();
    expect(() => authorizedKeysLine(KEY, "1.2.3.4", "menara:a b:K")).toThrow();
  });
});

describe("fromAddress", () => {
  it("uses the subnet for own-network clients and the address otherwise", () => {
    expect(fromAddress("172.29.0.7 51000 22", "172.29.0.0/16")).toBe(
      "172.29.0.0/16"
    );
    expect(fromAddress("203.0.113.10 5 22", "172.29.0.0/16")).toBe(
      "203.0.113.10"
    );
    expect(fromAddress("203.0.113.10 5 22", null)).toBe("203.0.113.10");
  });

  it("returns null when SSH_CLIENT does not start with an IP", () => {
    expect(fromAddress("", null)).toBeNull();
    expect(fromAddress("   ", "172.29.0.0/16")).toBeNull();
    expect(fromAddress('1.2.3.4",command="id 1 22', null)).toBeNull();
    expect(
      fromAddress("sudo: unable to resolve host", "172.29.0.0/16")
    ).toBeNull();
  });

  it("falls back to the plain address on an invalid subnet", () => {
    expect(fromAddress("172.29.0.7 1 22", "172.29.0.0/99")).toBe("172.29.0.7");
    expect(fromAddress("172.29.0.7 1 22", "garbage")).toBe("172.29.0.7");
  });
});

describe("keyMarker", () => {
  it("embeds the instance name and key id", () => {
    vi.stubEnv("COMPOSE_PROJECT_NAME", "acme-2");
    expect(keyMarker("abc")).toBe("menara:acme-2:abc");
  });

  it("falls back to menara when the project name is missing or invalid", () => {
    vi.stubEnv("COMPOSE_PROJECT_NAME", "");
    expect(keyMarker("abc")).toBe("menara:menara:abc");
    vi.stubEnv("COMPOSE_PROJECT_NAME", "bad name:x");
    expect(keyMarker("abc")).toBe("menara:menara:abc");
  });
});

describe("legacy key markers", () => {
  const ID = "0b7c9f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
  const OTHER = "5f1e2d3c-4b5a-4968-8776-655443322110";
  const line = (marker: string, key = "AAAA") =>
    authorizedKeysLine(
      `ssh-ed25519 ${key} x`,
      "10.0.0.1",
      `menara:x:${ID}`
    ).replace(`menara:x:${ID}`, marker);
  const LEGACY = `oldtool:oldtool-beta:${ID}`;

  beforeEach(() => {
    vi.stubEnv("COMPOSE_PROJECT_NAME", "acme");
    vi.stubEnv("MENARA_LEGACY_NAME", "oldtool");
    vi.stubEnv("MENARA_LEGACY_INSTANCE", "oldtool-beta");
  });

  it("legacyKeyMarker uses the legacy instance, else the legacy name", () => {
    expect(
      legacyKeyMarker(ID, {
        name: "oldtool",
        upper: "OLDTOOL",
        title: "Oldtool",
        instance: "oldtool-beta",
      })
    ).toBe(LEGACY);
    expect(
      legacyKeyMarker(ID, {
        name: "oldtool",
        upper: "OLDTOOL",
        title: "Oldtool",
        instance: null,
      })
    ).toBe(`oldtool:oldtool:${ID}`);
    expect(
      legacyKeyMarker(ID, {
        name: "oldtool",
        upper: "OLDTOOL",
        title: "Oldtool",
        instance: "bad name",
      })
    ).toBeNull();
  });

  it("recognises a legacy key line", () => {
    const marker = keyMarker(ID);
    const old = line(LEGACY, "OLD");
    const fresh = line(marker, "NEW");
    expect(isOurs(old, marker)).toBe(true);
    const existing = `ssh-rsa A a\n${old}\nssh-rsa B b\n`;
    // Merge replaces the legacy line in place; remove drops it.
    expect(mergeAuthorizedKeys(existing, fresh, marker)).toBe(
      `ssh-rsa A a\n${fresh}\nssh-rsa B b\n`
    );
    expect(removeAuthorizedKey(existing, marker)).toBe(
      "ssh-rsa A a\nssh-rsa B b\n"
    );
    // Both forms of one key collapse to the one line written.
    expect(
      mergeAuthorizedKeys(`${old}\n${line(marker)}\n`, fresh, marker)
    ).toBe(`${fresh}\n`);
  });

  it("writes only menara markers", () => {
    expect(keyMarker(ID)).toBe(`menara:acme:${ID}`);
    expect(() =>
      authorizedKeysLine("ssh-ed25519 AAAA x", "10.0.0.1", LEGACY)
    ).toThrow(/marker/);
  });

  it("accepts exactly the legacy marker, nothing wider", () => {
    const marker = keyMarker(ID);
    for (const near of [
      `oldtool:oldtool:${ID}`, // another legacy instance
      `oldtool:oldtool-beta:${OTHER}`, // another key
      `oldtool:oldtool-beta:${ID}x`,
      `OLDTOOL:oldtool-beta:${ID}`,
      `xoldtool:oldtool-beta:${ID}`,
      `oldtool:oldtool-beta:oldtool-beta:${ID}`,
    ]) {
      expect(isOurs(line(near), marker)).toBe(false);
    }
    expect(isOurs(`# ${LEGACY}`, marker)).toBe(false);
  });

  it("dropOtherInstanceKeys keeps this key's legacy line and drops a retired key's", () => {
    const keep = keyMarker(ID);
    const retired = keyMarker(OTHER);
    const kept = line(LEGACY);
    const stale = line(`oldtool:oldtool-beta:${OTHER}`);
    const foreign = line(
      `oldtool:oldtool-beta:9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d`
    );
    const { content, dropped } = dropOtherInstanceKeys(
      `${kept}\n${stale}\n${foreign}\n`,
      [keep],
      [keep, retired]
    );
    expect(content).toBe(`${kept}\n${foreign}\n`);
    expect(dropped).toEqual([{ marker: retired, line: stale }]);
  });

  it("with legacy unset, only menara markers are ours", () => {
    vi.stubEnv("MENARA_LEGACY_NAME", "");
    const marker = keyMarker(ID);
    expect(isOurs(line(LEGACY), marker)).toBe(false);
    const existing = `${line(LEGACY)}\n`;
    expect(removeAuthorizedKey(existing, marker)).toBe(existing);
    expect(dropOtherInstanceKeys(existing, [], [marker]).dropped).toEqual([]);
  });
});

describe("ensureCurrentKey", () => {
  it("is idempotent", async () => {
    const a = await ensureCurrentKey();
    const b = await ensureCurrentKey();
    expect(rows).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(a.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("returns the winner's row when the insert loses the race", async () => {
    racingWinner = {
      id: "winner",
      status: "current",
      publicKey: "ssh-ed25519 WIN",
      fingerprint: "SHA256:w",
      privateKey: "enc:p",
    };
    const key = await ensureCurrentKey();
    expect(key).toEqual({
      id: "winner",
      publicKey: "ssh-ed25519 WIN",
      fingerprint: "SHA256:w",
    });
    expect(rows).toHaveLength(1);
  });
});

describe("loadPrivateKey", () => {
  it("selects by id and decrypts", async () => {
    rows.push(
      { id: "a", status: "previous", privateKey: "enc:PEM-A" },
      { id: "b", status: "current", privateKey: "enc:PEM-B" }
    );
    expect(await loadPrivateKey("b")).toBe("PEM-B");
    expect(await loadPrivateKey("a")).toBe("PEM-A");
    await expect(loadPrivateKey("zzz")).rejects.toThrow();
  });
});

describe("from= width", () => {
  it("allows /8 to /32 for IPv4 and /32 to /128 for IPv6", () => {
    for (const ok of ["10.0.0.0/8", "10.1.2.3/32", "fd00::/32", "::1/128"]) {
      expect(isValidFrom(ok), ok).toBe(true);
    }
    for (const bad of [
      "0.0.0.0/0",
      "::/0",
      "10.0.0.0/7",
      "fd00::/31",
      // IPv4-mapped or embedded IPv6, and zone ids (normaliseSubnet refuses
      // them too).
      "::ffff:0.0.0.0/96",
      "::ffff:10.0.0.1",
      "::10.0.0.1/104",
      "fe80::1%eth0",
    ]) {
      expect(isValidFrom(bad), bad).toBe(false);
    }
  });
});

describe("fromOfLine", () => {
  it("reads the from= of a line we wrote, and refuses anything else", () => {
    expect(fromOfLine(OURS)).toBe("10.0.0.1");
    expect(fromOfLine(`${OURS}\r`)).toBe("10.0.0.1");
    expect(fromOfLine("ssh-ed25519 AAAA x")).toBeNull();
    expect(
      fromOfLine('from="0.0.0.0/0",no-agent-forwarding ssh-ed25519 AAAA x')
    ).toBeNull();
  });
});
