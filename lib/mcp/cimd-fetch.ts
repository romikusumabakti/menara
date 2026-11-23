import { fetchClientMetadataResource } from "@better-auth/cimd/node";

// The transport the CIMD plugin fetches an agent's client metadata document
// with. The client_id is a URL the agent picks, so this is a server-side
// request to a host an attacker may control.
//
// The network-level guard is better-auth's own Node transport: it resolves
// the host once, refuses unless every answer is public-routable (RFC 6890
// special-purpose ranges, loopback, private, link-local, shared address
// space), connects to the checked addresses through a pinned `lookup` (so a
// second DNS answer can't rebind the connection) and keeps the hostname for
// TLS SNI and certificate checks. Bun's node:https honours both, which the
// task that added this verified on a real socket.
//
// On top of it, this wrapper refuses what the plugin would also refuse later,
// so the transport is safe on its own: any redirect (304 still passes, it is
// how a cached document is revalidated), a body over 5 KB, and a request that
// takes longer than 5 s from the first byte sent to the last byte read.

const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 5 * 1024;

function tooLarge(): TypeError {
  return new TypeError("metadata document exceeds 5 KB");
}

export async function fetchClientMetadataSafely(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException("metadata fetch timed out", "TimeoutError")
      ),
    TIMEOUT_MS
  );
  const signal = init?.signal
    ? AbortSignal.any([init.signal, deadline.signal])
    : deadline.signal;

  let response: Response;
  try {
    response = await fetchClientMetadataResource(input, { ...init, signal });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }

  const refuse = async (error: Error): Promise<never> => {
    clearTimeout(timer);
    await response.body?.cancel().catch(() => {});
    throw error;
  };
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.status !== 304
  ) {
    return refuse(new TypeError("metadata server answered with a redirect"));
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse(tooLarge());
  }
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }

  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          clearTimeout(timer);
          controller.error(tooLarge());
          return;
        }
        controller.enqueue(chunk);
      },
      flush() {
        clearTimeout(timer);
      },
    }),
    { signal }
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
