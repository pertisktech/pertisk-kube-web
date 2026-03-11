/**
 * Realtime transport: WebTransport (when available) with WebSocket fallback.
 * Same JSON protocol: subscribe / resource_update / subscribed / error.
 *
 * WebTransport URL comes from config only (no same-host check):
 * 1. Runtime: GET /api/config → webtransport_url (backend env WEBTRANSPORT_PUBLIC_URL)
 * 2. Build time: VITE_WEBTRANSPORT_URL
 */

export interface RealtimeConnectionCallbacks {
  onMessage: (data: Record<string, unknown>) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

interface FrontendConfig {
  webtransport_url?: string | null;
  /** SHA-256 cert hash as [n1, n2, ...]; use new Uint8Array(this) for serverCertificateHashes (like pertisk-web-transport). */
  webtransport_cert_hash?: number[] | null;
}

let cachedConfig: FrontendConfig | null = null;

/** After one WebTransport handshake failure, skip WT and use WebSocket only (avoids repeated cert errors). */
let webTransportFailedOnce = false;

/** Single probe promise: only one handshake attempt per page load (parallel connections share this). */
let webTransportProbe: Promise<{ ok: boolean; withHash: boolean }> | null = null;

function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Run one WebTransport handshake. For localhost, try without serverCertificateHashes first (mkcert
 * is trusted by the system); if that fails, try with hash. For other hosts, use hash only.
 * On failure, set webTransportFailedOnce so all connections use WebSocket.
 */
function probeWebTransportOnce(
  wtUrl: string,
  certHash: ArrayBuffer | null
): Promise<{ ok: boolean; withHash: boolean }> {
  if (webTransportFailedOnce) return Promise.resolve({ ok: false, withHash: false });
  if (webTransportProbe === null) {
    webTransportProbe = (async () => {
      const Ctor = (window as unknown as {
        WebTransport: new (url: string, options?: { serverCertificateHashes: Array<{ algorithm: string; value: ArrayBuffer }> }) => WebTransport;
      }).WebTransport;

      const tryConnect = (withHash: boolean, hash: ArrayBuffer | null): Promise<boolean> => {
        return (async () => {
          try {
            if (withHash && hash && hash.byteLength === 32) {
              const transport = new Ctor(wtUrl, {
                serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
              });
              await transport.ready;
              transport.close();
            } else {
              const transport = new Ctor(wtUrl);
              await transport.ready;
              transport.close();
            }
            return true;
          } catch {
            return false;
          }
        })();
      };

      // When we have a cert hash from /api/config, always try with hash first to avoid a failed
      // handshake (CERTIFICATE_VERIFY_FAILED) that would otherwise happen when the cert is
      // not trusted or hostname doesn't match (e.g. localhost with *.example.com cert).
      const hasHash = certHash != null && certHash.byteLength === 32;
      if (hasHash) {
        const withHash = await tryConnect(true, certHash);
        if (withHash) {
          console.log('[realtime] WebTransport (serverCertificateHashes)', wtUrl);
          return { ok: true, withHash: true };
        }
      }
      const localhost = isLocalhostUrl(wtUrl);
      if (localhost && !hasHash) {
        const withoutHash = await tryConnect(false, null);
        if (withoutHash) {
          console.log('[realtime] WebTransport (localhost, system trust e.g. mkcert)', wtUrl);
          return { ok: true, withHash: false };
        }
      }

      webTransportFailedOnce = true;
      console.warn('[realtime] WebTransport failed, using WebSocket');
      return { ok: false, withHash: false };
    })();
  }
  return webTransportProbe;
}

/** Fetch /api/config once and cache (runtime env: WEBTRANSPORT_PUBLIC_URL). */
async function getFrontendConfig(bypassCache = false): Promise<FrontendConfig> {
  if (!bypassCache && cachedConfig !== null) return cachedConfig;
  try {
    const base = window.location.origin;
    const res = await fetch(`${base}/api/config`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = (await res.json()) as FrontendConfig;
      if (!bypassCache) cachedConfig = data;
      return data;
    }
  } catch {
    // ignore; fall back to build-time env
  }
  if (!bypassCache) cachedConfig = {};
  return cachedConfig ?? {};
}

/** Effective WebTransport URL: runtime config (WEBTRANSPORT_PUBLIC_URL) or build-time (VITE_WEBTRANSPORT_URL). */
function normalizeWebTransportUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  let trimmed = raw.trim();
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return null;
  }
  if (trimmed.startsWith('/')) {
    return `${window.location.origin}${trimmed}`;
  }
  // WebTransport requires a full URL (e.g. https://host/path). If only hostname or host:port, prepend https://
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

/** Resolve WebTransport URL from /api/config then env. Returns null if not set or not secure context. */
export async function getEffectiveWebTransportUrl(): Promise<string | null> {
  const config = await getFrontendConfig();
  const raw = config.webtransport_url ?? (import.meta.env.VITE_WEBTRANSPORT_URL as string | undefined);
  return normalizeWebTransportUrl(raw ?? '');
}

/** Cert hash from /api/config (array of 32 bytes); when present, use serverCertificateHashes like pertisk-web-transport. */
export async function getWebTransportCertHash(bypassCache = false): Promise<ArrayBuffer | null> {
  const config = await getFrontendConfig(bypassCache);
  const arr = config.webtransport_cert_hash;
  if (!Array.isArray(arr) || arr.length !== 32) return null;
  try {
    // Ensure exactly 32-byte ArrayBuffer (some browsers require exact length for serverCertificateHashes).
    const buf = new ArrayBuffer(32);
    new Uint8Array(buf).set(arr.slice(0, 32));
    return buf;
  } catch {
    return null;
  }
}

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.host;
  return `${protocol}://${host}/ws`;
}

function connectWebSocket(
  resourceType: string,
  callbacks: RealtimeConnectionCallbacks
): () => void {
  const { onMessage, onOpen, onClose, onError } = callbacks;
  const wsUrl = getWebSocketUrl();
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', resource: resourceType }));
    onOpen?.();
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      onMessage(data);
    } catch (e) {
      onError?.(e);
    }
  };

  ws.onerror = (event) => onError?.(event);
  ws.onclose = () => onClose?.();

  return () => {
    ws.close();
  };
}

async function connectWebTransport(
  resourceType: string,
  callbacks: RealtimeConnectionCallbacks,
  url: string,
  serverCertificateHash: ArrayBuffer | null
): Promise<() => void> {
  const { onMessage, onOpen, onClose, onError } = callbacks;
  if (!url) {
    throw new Error('WebTransport URL not available');
  }

  type WTOptions = { serverCertificateHashes: Array<{ algorithm: string; value: ArrayBuffer }> };
  const TransportCtor = (window as unknown as { WebTransport: new (url: string, options?: WTOptions) => WebTransport }).WebTransport;
  const transport =
    serverCertificateHash && serverCertificateHash.byteLength === 32
      ? new TransportCtor(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value: serverCertificateHash }] })
      : new TransportCtor(url);
  await transport.ready;

  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Send subscribe
  await writer.write(encoder.encode(JSON.stringify({ type: 'subscribe', resource: resourceType }) + '\n'));
  onOpen?.();

  let closed = false;
  let buffer = '';

  const readLoop = async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed) as Record<string, unknown>;
            onMessage(data);
          } catch {
            // ignore parse errors for non-JSON lines
          }
        }
      }
    } catch (e) {
      if (!closed) onError?.(e);
    } finally {
      if (!closed) onClose?.();
    }
  };

  readLoop(); // don't await

  return () => {
    closed = true;
    try {
      writer.close();
      reader.cancel();
    } catch {
      // ignore
    }
  };
}

const hasWebTransportAPI = (): boolean =>
  typeof (window as unknown as { WebTransport?: unknown }).WebTransport === 'function';

/**
 * Open a realtime connection for the given resource type.
 * Uses WebTransport when available (URL from /api/config or VITE_WEBTRANSPORT_URL), else WebSocket.
 * Returns a cleanup function that closes the connection.
 */
export function openRealtimeConnection(
  resourceType: string,
  callbacks: RealtimeConnectionCallbacks
): () => void {
  const closeRef: { current: (() => void) | null } = { current: null };
  (async () => {
    const wtUrl = await getEffectiveWebTransportUrl();
    const certHash = await getWebTransportCertHash(true);
    const hasCertHash = certHash != null && certHash.byteLength === 32;
    const localhost = wtUrl ? isLocalhostUrl(wtUrl) : false;
    // Use WT when we have a URL and (cert hash for pinning, or localhost to try system trust first).
    const useWT = !webTransportFailedOnce && wtUrl && hasWebTransportAPI() && (hasCertHash || localhost);
    if (useWT) {
      const { ok, withHash } = await probeWebTransportOnce(wtUrl, certHash ?? null);
      if (ok) {
        try {
          closeRef.current = await connectWebTransport(resourceType, callbacks, wtUrl, withHash ? certHash ?? null : null);
        } catch (e) {
          closeRef.current = connectWebSocket(resourceType, callbacks);
        }
      } else {
        closeRef.current = connectWebSocket(resourceType, callbacks);
      }
    } else {
      if (!wtUrl) console.log('[realtime] No WebTransport URL (check /api/config), using WebSocket');
      else if (!hasWebTransportAPI()) console.log('[realtime] WebTransport API not available, using WebSocket');
      else if (!hasCertHash && !localhost) console.log('[realtime] No cert hash and not localhost, using WebSocket');
      else if (webTransportFailedOnce) { /* silent: already failed once, use WebSocket */ }
      closeRef.current = connectWebSocket(resourceType, callbacks);
    }
  })();
  return () => {
    closeRef.current?.();
    closeRef.current = null;
  };
}

/**
 * Opens a realtime connection; when WebTransport is used, the returned Promise resolves to the actual close function
 * after the connection is established. Use this when you need to ensure close() is the correct one for the transport.
 */
export async function openRealtimeConnectionAsync(
  resourceType: string,
  callbacks: RealtimeConnectionCallbacks
): Promise<() => void> {
  const wtUrl = await getEffectiveWebTransportUrl();
  const certHash = await getWebTransportCertHash(true);
  const hasCertHash = certHash != null && certHash.byteLength === 32;
  const localhost = wtUrl ? isLocalhostUrl(wtUrl) : false;
  const useWT = !webTransportFailedOnce && wtUrl && hasWebTransportAPI() && (hasCertHash || localhost);
  if (useWT) {
    const { ok, withHash } = await probeWebTransportOnce(wtUrl, certHash ?? null);
    if (ok) {
      return connectWebTransport(resourceType, callbacks, wtUrl, withHash ? certHash ?? null : null)
        .catch(() => Promise.resolve(connectWebSocket(resourceType, callbacks)));
    }
  }
  if (!wtUrl) console.log('[realtime] No WebTransport URL (check /api/config), using WebSocket');
  else if (!hasWebTransportAPI()) console.log('[realtime] WebTransport API not available, using WebSocket');
  else if (!hasCertHash && !localhost) console.log('[realtime] No cert hash and not localhost, using WebSocket');
  return connectWebSocket(resourceType, callbacks);
}
