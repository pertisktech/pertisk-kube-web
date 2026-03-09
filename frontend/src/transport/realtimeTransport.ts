/**
 * Realtime transport: WebTransport (when available) with WebSocket fallback.
 * Same JSON protocol: subscribe / resource_update / subscribed / error.
 *
 * WebTransport URL is resolved from (in order):
 * 1. Runtime: GET /api/config → webtransport_url (env WEBTRANSPORT_PUBLIC_URL on backend)
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
}

let cachedConfig: FrontendConfig | null = null;

/** Fetch /api/config once and cache (runtime env: WEBTRANSPORT_PUBLIC_URL). */
async function getFrontendConfig(): Promise<FrontendConfig> {
  if (cachedConfig !== null) return cachedConfig;
  try {
    const base = window.location.origin;
    const res = await fetch(`${base}/api/config`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = (await res.json()) as FrontendConfig;
      cachedConfig = data;
      return data;
    }
  } catch {
    // ignore; fall back to build-time env
  }
  cachedConfig = {};
  return cachedConfig;
}

/** Effective WebTransport URL: runtime config (WEBTRANSPORT_PUBLIC_URL) or build-time (VITE_WEBTRANSPORT_URL). */
function normalizeWebTransportUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return null;
  }
  if (trimmed.startsWith('/')) {
    return `${window.location.origin}${trimmed}`;
  }
  return trimmed;
}

/** Resolve WebTransport URL from /api/config then env. Returns null if not set or not secure context. */
export async function getEffectiveWebTransportUrl(): Promise<string | null> {
  const config = await getFrontendConfig();
  const raw = config.webtransport_url ?? (import.meta.env.VITE_WEBTRANSPORT_URL as string | undefined);
  return normalizeWebTransportUrl(raw ?? '');
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
  url: string
): Promise<() => void> {
  const { onMessage, onOpen, onClose, onError } = callbacks;
  if (!url) {
    throw new Error('WebTransport URL not available');
  }

  const transport = new (window as unknown as { WebTransport: new (url: string) => WebTransport }).WebTransport(url);
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
    if (wtUrl && hasWebTransportAPI()) {
      try {
        closeRef.current = await connectWebTransport(resourceType, callbacks, wtUrl);
      } catch (e) {
        if (import.meta.env.DEV) {
          console.debug('[realtime] WebTransport failed, using WebSocket:', e);
        }
        closeRef.current = connectWebSocket(resourceType, callbacks);
      }
    } else {
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
  if (wtUrl && hasWebTransportAPI()) {
    return connectWebTransport(resourceType, callbacks, wtUrl).catch((e) => {
      if (import.meta.env.DEV) {
        console.debug('[realtime] WebTransport failed, using WebSocket:', e);
      }
      return Promise.resolve(connectWebSocket(resourceType, callbacks));
    });
  }
  return connectWebSocket(resourceType, callbacks);
}
