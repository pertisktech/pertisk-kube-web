# WebTransport and Your Kubernetes Deployment

## How to test if WebTransport works

Use a **browser** (Chrome/Edge; WebTransport is not in all browsers). You must be on an **HTTPS** page (or `localhost`).

### Option 1: Browser DevTools Console

1. Open your dashboard (or any HTTPS page), e.g. `https://dashboard.talos-hz.thaidevops.co`.
2. Open DevTools (F12) → **Console**.
3. Paste and run this (replace the URL if needed):

```javascript
(async () => {
  const url = 'https://wt.talos-hz.thaidevops.co/wt';
  console.log('Connecting to', url, '...');
  try {
    const t = new WebTransport(url);
    await t.ready;
    console.log('✓ WebTransport ready');
    const stream = await t.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    await writer.write(new TextEncoder().encode(JSON.stringify({ type: 'subscribe', resource: 'pods' }) + '\n'));
    const { value } = await reader.read();
    const msg = new TextDecoder().decode(value);
    console.log('✓ Server reply:', msg);
    writer.close();
    reader.cancel();
    t.close();
    return 'WebTransport OK';
  } catch (e) {
    console.error('✗ WebTransport failed:', e);
    return 'WebTransport FAIL: ' + e.message;
  }
})();
```

- **If it works:** You see `WebTransport ready` and `Server reply: {"type":"subscribed",...}` (or `resource_update`). Realtime in the app will use WebTransport when this URL is configured.
- **If it fails:** You see an error (e.g. `QUIC_NETWORK_IDLE_TIMEOUT`, `Failed to connect`, or `net::ERR_*`). Then check UDP/ingress/proxy and TLS (see sections below).

### Option 2: Google’s WebTransport client (no paste required)

Use the official sample page to test any WebTransport URL:

1. Open **[WebTransport over HTTP/3 client](https://googlechrome.github.io/samples/webtransport/client.html)** in Chrome or Edge.
2. In **URL**, enter your endpoint, e.g. `https://wt.talos-hz.thaidevops.co/wt`.
3. Click **Establish WebTransport connection**.
4. If it connects, try **Open a bidirectional stream** and send a line such as:  
   `{"type":"subscribe","resource":"pods"}\n`  
   to match your backend protocol; check the event log for the server reply.

Limitations of this page: it sends the whole stream at once and doesn’t listen for server-initiated streams, but it is enough to verify that the connection and handshake work.

### Option 3: From another HTTPS page (Console script)

You can run the Console script from any HTTPS tab. WebTransport allows cross-origin connections to your WT URL; no CORS is involved for the QUIC connection.

### What the backend expects

- **URL:** Any path is accepted (e.g. `/` or `/wt`); the backend does not filter by path.
- **Protocol:** First message on the bidirectional stream must be a JSON line:  
  `{"type":"subscribe","resource":"pods"}` (or `nodes`, `deployments`, etc.).  
  Server replies with `{"type":"subscribed","resource":"..."}` then streams `resource_update` messages.

### "Connection lost" and reconnect (local dev)

When you see **`WebTransportError: Connection lost`** followed by **"Realtime disconnected"** and **"Attempting to reconnect..."**:

- **Cause:** The WebTransport (or WebSocket) connection to the backend was closed. Common reasons:
  1. **Backend restarted** — e.g. `make run-ingress-k8s` uses `cargo watch`; any backend recompile restarts the process and drops all connections.
  2. **Backend error** — an unhandled error on the server can close the connection.
  3. **Network / idle** — less common on localhost.

- **What you see:** After "Connection lost", the frontend tries to reconnect. If the backend is still down (e.g. restarting), you get **`ERR_CONNECTION_REFUSED`** (port 4433) and **WebSocket failed** (port 8091). Once the backend is up again, the next reconnect succeeds and you see **"Using WebTransport"** again.

- **If you want stable connections while testing:** Run the backend without watch (e.g. `STATIC_DIR=frontend/dist WEBTRANSPORT_PORT=4433 cargo run -p pertisk-kube-backend` with cert env if needed) so it doesn’t restart on file changes. Reconnect logic is normal and expected when the server restarts.

### Local dev: trusted certs with mkcert (avoid QUIC_TLS_CERTIFICATE_UNKNOWN)

When running WebTransport locally (`make run-ingress-k8s`), the backend uses TLS on port 4433. A **self-signed** cert causes the browser to show `QUIC_TLS_CERTIFICATE_UNKNOWN` / `CERTIFICATE_VERIFY_FAILED`. Use **mkcert** so the browser trusts the cert:

1. Install mkcert and install the local CA (one-time):  
   `brew install mkcert && mkcert -install`
2. Generate certs in the repo:  
   `make certs`  
   This creates `certs/localhost.pem` and `certs/localhost-key.pem` (gitignored).
3. Run the app:  
   `make run-ingress-k8s`  
   The Makefile passes `WEBTRANSPORT_TLS_CERT` / `WEBTRANSPORT_TLS_KEY` when those files exist, so the WebTransport server uses the mkcert cert and the browser connects without certificate errors.

---

## ERR_METHOD_NOT_SUPPORTED

If the browser shows **`Failed to establish a connection to https://wt.talos-hz.thaidevops.co/: net::ERR_METHOD_NOT_SUPPORTED`** (and then **Opening handshake failed**):

- **Cause:** The host you’re connecting to is **not** speaking WebTransport. The server (or proxy) at that URL is accepting HTTPS but does **not** support the WebTransport handshake (HTTP/3 + extended CONNECT). It may be a normal HTTP/1.1 or HTTP/2 server that only allows GET/POST, so the WebTransport “method” is rejected.
- **Correct endpoint:** The URL in `app.webtransport.publicUrl` must point to a **real WebTransport/HTTP/3 server** (or a proxy that forwards QUIC to one). That is either:
  - Your **pertisk-kube** WebTransport server, reachable directly (e.g. `https://wt.talos-hz.thaidevops.co:50052` if the LB exposes UDP 50052 to the backend), or
  - A **reverse proxy** (e.g. pt-rproxy) that is explicitly configured to handle WebTransport for this host and forward to the backend’s WebTransport port.
- **If the proxy doesn’t support WebTransport yet:** Unset `app.webtransport.publicUrl` (or set it to `""`) so the frontend does not try WebTransport and uses **WebSocket** for realtime over the main dashboard host.

---

## "Opening handshake failed" (WebTransportError)

If the browser shows **`WebTransportError: Opening handshake failed`** when connecting to your WebTransport URL (e.g. `https://wt.talos-hz.thaidevops.co/` or `https://wt.talos-hz.thaidevops.co/wt`):

The **opening handshake** is the HTTP/3 + WebTransport session setup (TLS, then WebTransport extended CONNECT). Failure usually means one of:

| Cause | What to check |
|-------|----------------|
| **Endpoint is not WebTransport** | The URL must be served over **HTTP/3 (QUIC)** and support WebTransport. If the host only serves TCP/TLS (e.g. plain HTTPS or HTTP/2), the WebTransport handshake will fail. Ensure the server (or proxy) actually listens for QUIC and responds to WebTransport. |
| **Proxy doesn’t support WebTransport** | If `wt.talos-hz.thaidevops.co` goes through pt-rproxy (or another proxy), the proxy must **support WebTransport over HTTP/3** for that host and either terminate the session correctly or **pass through** QUIC to the backend. If it downgrades to TCP or doesn’t handle the WebTransport CONNECT, you get opening handshake failed. |
| **TLS / certificate** | The certificate for the host must be valid and trusted (e.g. not self-signed unless you added an exception). Wrong hostname or expired cert can also cause handshake failure. |
| **Backend not reachable** | If the proxy is supposed to forward to pertisk-kube’s WebTransport port, ensure the backend pod is listening, the Service exposes the WebTransport port (UDP), and the proxy is configured to route that host/path to the backend. |

**Practical steps:**

1. **Confirm the endpoint is HTTP/3 + WebTransport**  
   Use the same URL in the [Chrome WebTransport client](https://googlechrome.github.io/samples/webtransport/client.html). If “Establish WebTransport connection” fails with “Opening handshake failed”, the problem is on the server/proxy side (protocol or TLS), not the test page.

2. **If you use pt-rproxy**  
   See [pt-rproxy WebTransport reverse proxy](https://github.com/pertisksoft/pt-rproxy/blob/master/docs/WEBTRANSPORT_REVERSE_PROXY.md). The proxy must be configured to accept HTTP/3 and WebTransport for `wt.talos-hz.thaidevops.co` (and use a valid TLS cert for that host).

3. **Temporary workaround**  
   Disable WebTransport for the UI (unset `app.webtransport.publicUrl` and don’t set `VITE_WEBTRANSPORT_URL`). The app will use WebSocket for realtime over the main dashboard host, which works without WebTransport/QUIC.

---

## ERR_QUIC_PROTOCOL_ERROR / QUIC_NETWORK_IDLE_TIMEOUT

If the browser shows **`ERR_QUIC_PROTOCOL_ERROR`** with **`QUIC_NETWORK_IDLE_TIMEOUT (No recent network activity after ... Timeout:4s)`** when connecting to the WebTransport URL (e.g. `https://dashboard.talos-hz.thaidevops.co:8443/`):

- **Cause:** WebTransport uses **QUIC**, which runs over **UDP**. The client sends QUIC (UDP) packets; if nothing forwards **UDP** to the backend (e.g. Service or LoadBalancer only exposes **TCP** 8443), the server never sees the handshake and the client times out after ~4s.
- **Fix:**
  1. **In-cluster:** The chart exposes the webtransport port as **UDP** in the Service and Deployment. Upgrade the release so the Service has `protocol: UDP` for the webtransport port.
  2. **To the internet:** Your LoadBalancer (MetalLB, cloud LB, or whatever fronts the cluster) must expose **UDP 8443** and forward it to the nodes (e.g. NodePort or hostPort for UDP 8443). If the LB only has TCP 8443, add UDP 8443.

After fixing, redeploy and ensure UDP 8443 is open in any firewall between the client and the pod.

## Cluster check (talos-omni-hz, pertisk-rproxy)

- **Pods:** pertisk-kube 3/3 Running.
- **Deployment:** Has `WEBTRANSPORT_PORT=4433`, container port 4433 (webtransport).
- **Service:** pertisk-kube exposes 8091, 50051, **4433** (ClusterIP only).
- **App logs:** Backend logs `WebTransport server listening on port 4433` at startup — WT is running inside the cluster.
- **Ingress:** `dashboard-talos-hz-thaidevops-co` forwards **only to port 8091**:
  - `path: /` → `pertisk-kube:8091`

## Why WebTransport doesn’t work from the browser

1. Users hit `https://dashboard.talos-hz.thaidevops.co` (port 443).
2. The ingress controller sends that traffic to **pertisk-kube:8091** only. There is no rule that forwards to **pertisk-kube:4433**.
3. So the WebTransport port 4433 is **never reachable from outside**; it’s only on the ClusterIP.
4. Path-based WebTransport (e.g. `/wt`) also doesn’t work: standard ingress doesn’t proxy WebTransport/HTTP/3 to a backend port.

## Options

### A. Use WebSocket only (recommended for this setup)

- Rebuild the frontend **without** `VITE_WEBTRANSPORT_URL`. Realtime will use WebSocket (`/ws`) over the same host/port (8091), which the ingress already forwards.
- No ingress or LoadBalancer changes.

### B. Expose WebTransport on a separate port (direct)

When you deploy with ports **8091/TCP, 50051/TCP, 50052/UDP** exposed (e.g. main Service type LoadBalancer or NodePort), traffic must be **directed** to the WebTransport port:

- **`publicUrl` must include the port.** Set `app.webtransport.publicUrl` to `https://wt.talos-hz.thaidevops.co:50052` (or your host with `:50052`). If you omit the port, the browser uses 443 and the connection does not reach the WebTransport server.
- **Optional: dedicated LoadBalancer for WebTransport.** Set `app.webtransport.exposeLoadBalancer: true` to create a second Service (e.g. `pertisk-kube-webtransport`) of type LoadBalancer that exposes only **50052/UDP**. Use the assigned external IP (or DNS pointing to it) in `publicUrl`, e.g. `https://wt.talos-hz.thaidevops.co:50052`.
- **WebTransport uses QUIC over UDP.** The Service declares the webtransport port as **UDP**. Your LB must expose **UDP** on that port; if only TCP is exposed, you get `ERR_QUIC_PROTOCOL_ERROR` / `QUIC_NETWORK_IDLE_TIMEOUT`.
- Ensure firewall and LB allow **UDP** on the WebTransport port (e.g. 50052).

### C. Ingress-level WebTransport/HTTP/3 to backend 4433

- If your ingress controller (e.g. pertisk-ingress) supports routing WebTransport or HTTP/3 by host/path to a backend port, add a rule that sends WebTransport for the dashboard host to `pertisk-kube:4433`. This is controller-specific and may require custom configuration.

## Proxy: "no server certificate chain resolved" (HTTP/3)

If **pertisk_rproxy** (pt-rproxy) logs:

```text
HTTP/3 connection failed during handshake: the cryptographic handshake failed: error 49: unexpected error: no server certificate chain resolved
```

- **Cause:** The proxy is accepting HTTP/3 (QUIC) but has **no TLS certificate chain** to present for the requested host (SNI). The QUIC/TLS handshake requires a server certificate; the proxy’s cert lookup returns nothing for that host.
- **Fix (in pt-rproxy / pertisk_rproxy config):**
  1. **Bind a certificate to the HTTP/3 listener** for the host clients use (e.g. `dashboard.talos-hz.thaidevops.co`). Ensure the proxy’s SNI → certificate mapping includes this host.
  2. **Use the full chain**, not just the leaf cert. For Let’s Encrypt use `fullchain.pem` (certificate + intermediates). rustls/Quinn needs the full chain to resolve the server certificate chain.
  3. If HTTP/3 is optional, you can **disable HTTP/3** on the proxy and use WebSocket for realtime (no QUIC), or expose WebTransport on a separate port where the backend serves TLS (see Option B above).

## Reverse proxy: HTTPS → HTTPS (pt-rproxy)

If you use **[pt-rproxy](https://github.com/pertisksoft/pt-rproxy)** as the ingress controller:

- **Why 502 on the WebTransport host:** The proxy forwards **HTTP** to the backend; the backend on 8443 speaks **QUIC/WebTransport**, so the connection fails and you get 502.
- **Guide for making it work:** See **[pt-rproxy docs: WebTransport reverse proxy](https://github.com/pertisksoft/pt-rproxy/blob/master/docs/WEBTRANSPORT_REVERSE_PROXY.md)** for:
  - **HTTPS to HTTPS** behaviour (client TLS → proxy → backend TLS/QUIC).
  - **Option 1:** QUIC passthrough in pt-rproxy (single domain, single port 443).
  - **Option 2:** Expose backend port 8443 on the LoadBalancer (e.g. `https://wt.example.com:8443`).
  - **Option 3:** Use WebSocket only (no WebTransport).
