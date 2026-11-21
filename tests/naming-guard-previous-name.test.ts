import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The product's previous name must appear nowhere in the repository. This
// file cannot spell it, so the guard knows only its length, an FNV-1a 32-bit
// hash and a sha256. Every lowercased window of that length in every tracked
// text file is prefiltered by the FNV hash and confirmed by the sha256. That
// also finds the name inside identifiers and constants (xxNameYY, NAME_X),
// which whole-word hashing would miss. The scanner takes the constants as a
// parameter, so a fictional name proves it works without writing the real one.

type Target = { length: number; fnv: number; sha: string };

const LEGACY_TOKEN_LENGTH = 7;
const LEGACY_TOKEN_FNV1A32 = 0xf0f6d57e;
const LEGACY_TOKEN_SHA256 =
  "bec8bf3c040d4e17d8767e4f3c14f060f9ccb87c03ba77a80be8b9741f15dd77";
const LEGACY: Target = {
  length: LEGACY_TOKEN_LENGTH,
  fnv: LEGACY_TOKEN_FNV1A32,
  sha: LEGACY_TOKEN_SHA256,
};

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const BINARY_SNIFF_BYTES = 8192;

function lowerAscii(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out[i] = b >= 65 && b <= 90 ? b + 32 : b;
  }
  return out;
}

function fnv1a32(bytes: Uint8Array, start: number, length: number): number {
  let h = FNV_OFFSET;
  for (let i = start; i < start + length; i++) {
    h = Math.imul(h ^ (bytes[i] as number), FNV_PRIME) >>> 0;
  }
  return h;
}

function sha256(bytes: Uint8Array, start: number, length: number): string {
  return createHash("sha256")
    .update(bytes.subarray(start, start + length))
    .digest("hex");
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Offsets (in bytes) of every window that is the target word, any case. */
function scan(bytes: Uint8Array, target: Target): number[] {
  if (isBinary(bytes)) return [];
  const lower = lowerAscii(bytes);
  const hits: number[] = [];
  for (let i = 0; i + target.length <= lower.length; i++) {
    if (
      fnv1a32(lower, i, target.length) === target.fnv &&
      sha256(lower, i, target.length) === target.sha
    ) {
      hits.push(i);
    }
  }
  return hits;
}

function targetOf(word: string): Target {
  const bytes = new TextEncoder().encode(word.toLowerCase());
  return {
    length: bytes.length,
    fnv: fnv1a32(bytes, 0, bytes.length),
    sha: sha256(bytes, 0, bytes.length),
  };
}

const scanText = (text: string, target: Target) =>
  scan(new TextEncoder().encode(text), target);

describe("previous-name guard scanner", () => {
  const fixture = targetOf("oldtool");

  it("finds the word inside identifiers and constants, in any case", () => {
    expect(scanText("const xxOldToolyy = 1", fixture)).toHaveLength(1);
    expect(scanText("OLDTOOL_X", fixture)).toEqual([0]);
    expect(scanText("oldtool oldtool", fixture)).toEqual([0, 8]);
  });

  it("ignores near misses and other words", () => {
    expect(scanText("oldtoo", fixture)).toEqual([]);
    expect(scanText("old tool", fixture)).toEqual([]);
    expect(scanText("oldtoal", fixture)).toEqual([]);
    expect(scanText("menara", fixture)).toEqual([]);
  });

  it("skips binary content", () => {
    const bytes = new Uint8Array([0, ...new TextEncoder().encode("oldtool")]);
    expect(scan(bytes, fixture)).toEqual([]);
  });
});

describe("previous-name guard", () => {
  it("no tracked file contains the previous product name", () => {
    const root = new URL("..", import.meta.url).pathname;
    const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
    if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
    const files = listed.stdout.toString().split("\0").filter(Boolean);
    const offenders: string[] = [];
    const started = performance.now();
    for (const file of files) {
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(`${root}${file}`);
      } catch {
        continue; // deleted in the working tree, or a submodule
      }
      if (scan(bytes, LEGACY).length > 0) offenders.push(file);
    }
    console.info(
      `previous-name guard: ${files.length} files in ${Math.round(performance.now() - started)} ms`
    );
    expect(offenders).toEqual([]);
  });
});
