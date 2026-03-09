# WebTransport and Your Kubernetes Deployment

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

### B. Expose WebTransport on a separate port

- **WebTransport uses QUIC over UDP.** The Service and Deployment declare the webtransport port as **UDP** (not TCP). Your LoadBalancer or node port must also forward **UDP** 8443 to the cluster; if only TCP is exposed, you get `ERR_QUIC_PROTOCOL_ERROR` / `QUIC_NETWORK_IDLE_TIMEOUT` (no packets reach the server).
- Expose **UDP** 4433/8443 on the LoadBalancer and route it to `pertisk-kube:8443` (controller-specific config).
- **Runtime config (no rebuild):** Set backend env **`WEBTRANSPORT_PUBLIC_URL`** (e.g. Helm `app.webtransport.publicUrl: "https://wt.example.com:8443"`). The frontend reads it from `GET /api/config`.
- **Build-time:** Alternatively set `VITE_WEBTRANSPORT_URL=https://...` at frontend build time.
- Browsers will connect to the given URL for WebTransport; ensure firewall and LB allow **UDP** on that port.

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
