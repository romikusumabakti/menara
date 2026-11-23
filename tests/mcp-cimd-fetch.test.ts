import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The transport better-auth's CIMD plugin fetches an agent's client metadata
// document with (lib/mcp/cimd-fetch.ts). The client_id is a URL the agent
// chooses, so this is a server-side request to an attacker-picked host: every
// address it resolves to must be public, the connection must use the address
// that was checked (no DNS rebinding), and a redirect, an oversized body or a
// stalled server must not get through.
//
// The resolver and the HTTPS client are stubbed (no network): the stubbed
// request answers through the `lookup` it was given, so the tests see the
// address the connection would really use. That Bun's node:https honours a
// custom `lookup` and still verifies the certificate against the hostname was
// probed separately on a real TLS socket (see the task report).

type Address = { address: string; family: number };
type Answer = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Never answer: the request hangs until aborted. */
  hang?: boolean;
};

const net = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string, options: unknown) => Promise<Address[]>>(),
  answer: { status: 200 } as Answer,
  requests: [] as {
    url: string;
    servername?: string;
    pinned: Address[];
    legacyPinned: string;
  }[],
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    default: { ...actual, lookup: net.lookup },
    lookup: net.lookup,
  };
});

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  type LookupCallback = (
    error: Error | null,
    address: string | Address[],
    family?: number
  ) => void;
  type Options = {
    servername?: string;
    signal?: AbortSignal;
    lookup: (
      hostname: string,
      options: { all?: boolean },
      cb: LookupCallback
    ) => void;
  };
  const request = (
    url: URL,
    options: Options,
    onResponse: (response: Readable & Record<string, unknown>) => void
  ) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      let pinned: Address[] = [];
      let legacyPinned = "";
      options.lookup(url.hostname, { all: true }, (_e, addresses) => {
        pinned = addresses as Address[];
      });
      options.lookup(url.hostname, {}, (_e, address) => {
        legacyPinned = address as string;
      });
      net.requests.push({
        url: url.href,
        servername: options.servername,
        pinned,
        legacyPinned,
      });
      const abort = () => req.emit("error", new Error("aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (net.answer.hang) return;
      const response = Readable.from(
        net.answer.body ? [Buffer.from(net.answer.body)] : []
      ) as Readable & Record<string, unknown>;
      response.statusCode = net.answer.status ?? 200;
      response.statusMessage = "";
      response.headers = net.answer.headers ?? {
        "content-type": "application/json",
      };
      queueMicrotask(() => onResponse(response));
    };
    return req;
  };
  return { ...actual, default: { ...actual, request }, request };
});

const { fetchClientMetadataSafely } = await import("@/lib/mcp/cimd-fetch");

const URL_OK = "https://agent.example.com/client-metadata.json";
const PUBLIC: Address = { address: "93.184.215.14", family: 4 };

beforeEach(() => {
  net.lookup.mockReset();
  net.lookup.mockResolvedValue([PUBLIC]);
  net.answer = { status: 200, body: "{}" };
  net.requests = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchClientMetadataSafely", () => {
  it("fetches a document from a public host", async () => {
    const res = await fetchClientMetadataSafely(URL_OK);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
  });

  it("refuses http URLs", async () => {
    await expect(
      fetchClientMetadataSafely("http://agent.example.com/client-metadata.json")
    ).rejects.toThrow();
    expect(net.lookup).not.toHaveBeenCalled();
    expect(net.requests).toHaveLength(0);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.56.113",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "100.64.0.1",
  ])("refuses a host resolving to %s", async (address) => {
    net.lookup.mockResolvedValue([
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await expect(fetchClientMetadataSafely(URL_OK)).rejects.toThrow(
      /public-routable/
    );
    // Refused on the stubbed answer, not on a real lookup failing.
    expect(net.lookup).toHaveBeenCalledTimes(1);
    expect(net.requests).toHaveLength(0);
  });

  it("refuses a host when any one of its addresses is private", async () => {
    net.lookup.mockResolvedValue([PUBLIC, { address: "10.0.0.5", family: 4 }]);
    await expect(fetchClientMetadataSafely(URL_OK)).rejects.toThrow();
    expect(net.requests).toHaveLength(0);
  });

  it("refuses a private IP literal without a lookup", async () => {
    await expect(
      fetchClientMetadataSafely("https://169.254.169.254/latest/meta-data")
    ).rejects.toThrow();
    expect(net.lookup).not.toHaveBeenCalled();
    expect(net.requests).toHaveLength(0);
  });

  it("refuses a redirect", async () => {
    net.answer = {
      status: 302,
      headers: { location: "https://127.0.0.1/metadata.json" },
    };
    await expect(fetchClientMetadataSafely(URL_OK)).rejects.toThrow(/redirect/);
    expect(net.requests).toHaveLength(1);
  });

  it("passes a 304 through for revalidation", async () => {
    net.answer = { status: 304, headers: {} };
    const res = await fetchClientMetadataSafely(URL_OK, {
      headers: { "If-None-Match": '"v1"' },
    });
    expect(res.status).toBe(304);
  });

  it("pins the first resolution (no rebinding)", async () => {
    net.lookup
      .mockResolvedValueOnce([PUBLIC])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await fetchClientMetadataSafely(URL_OK);
    expect(net.lookup).toHaveBeenCalledTimes(1);
    expect(net.requests).toEqual([
      {
        url: URL_OK,
        servername: "agent.example.com",
        pinned: [PUBLIC],
        legacyPinned: PUBLIC.address,
      },
    ]);
  });

  it("caps the body at 5 KB and times out at 5 s", async () => {
    net.answer = { status: 200, body: "x".repeat(5 * 1024) };
    const fits = await fetchClientMetadataSafely(URL_OK);
    expect((await fits.text()).length).toBe(5 * 1024);

    net.answer = { status: 200, body: "x".repeat(5 * 1024 + 1) };
    const large = await fetchClientMetadataSafely(URL_OK);
    await expect(large.text()).rejects.toThrow(/5 KB/);

    net.answer = {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "6000" },
      body: "x",
    };
    await expect(fetchClientMetadataSafely(URL_OK)).rejects.toThrow(/5 KB/);

    vi.useFakeTimers();
    net.answer = { hang: true };
    const pending = fetchClientMetadataSafely(URL_OK);
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toThrow();
  });
});
