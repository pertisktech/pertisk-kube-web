# Why pertisk-web-transport Works (local + reverse) and How to Fix pertisk-kube-web

## Base project: pertisk-web-transport

**One process, one Identity, one cert hash.**

- **Single binary** runs:
  - HTTP server (e.g. port 8092) → serves the demo **page** and injects the **cert hash** into the JS.
  - WebTransport server (port 8443) → uses the **same** `Identity` (same TLS cert).

So the cert hash in the page is **always** the hash of the cert that the WebTransport server presents.

### Why `https://localhost:8443/` works

- You open the page from `http://localhost:8092` (same machine).
- The page contains the cert hash for that process’s Identity.
- You connect to `https://localhost:8443/` → same process, same cert → hash matches → **works**.

### Why `https://wt2.m4pro.thaidevops.co:8443/` works (reverse, different server)

- **Different server** from localhost: localhost:8443 and wt2:8443 can be different machines/processes.
- They both work with the **same page** (and same cert hash) because **both servers use the same TLS certificate** (e.g. same self-signed cert or same PEM deployed on both).
- So: one cert hash in the page matches **both** localhost:8443’s cert **and** wt2:8443’s cert → **works for both**.

---

## pertisk-kube-web: why it often does not work

**Page and WebTransport URL can be different hosts, and TLS is often terminated in front of the app.**

- The **page** (and `/api/config`) is loaded from e.g. `https://app.m4pro.thaidevops.co`.
- The **WebTransport URL** is e.g. `https://wt.m4pro.thaidevops.co:4433/`.
- `/api/config` returns the cert hash of the **backend** that served the page (the backend’s WebTransport Identity).

What the client sees when connecting to `https://wt.m4pro.thaidevops.co:4433/`:

- If an **ingress/proxy terminates TLS** for `wt.m4pro.thaidevops.co`, the client sees the **proxy’s** certificate, not the backend’s.
- The hash in `/api/config` is for the **backend’s** cert → **hash ≠ proxy cert** → `QUIC_TLS_CERTIFICATE_UNKNOWN` / `CERTIFICATE_VERIFY_FAILED`.

So it “does not work” when:

1. Page host ≠ WebTransport URL host, **or**
2. TLS is terminated in front of the backend (client never sees the backend’s cert).

---

## How to make pertisk-kube-web work like the base project (both local + reverse)

Use the **same TLS certificate** on the server that serves `/api/config` and on the server at the WebTransport URL (e.g. wt.m4pro.thaidevops.co:4433). Then one cert hash works for both, like localhost:8443 and wt2:8443 in the base project.

- Deploy the **same cert** (same PEM files or same generated Identity) on:
  - The backend that serves the app and `/api/config`.
  - The backend (or proxy passthrough) that serves WebTransport at the configured WT URL.
- Then the hash in `/api/config` matches the cert at the WT URL → WebTransport works. No same-host restriction in the frontend.

### Option A: QUIC/TLS passthrough to the backend

- For `https://wt.m4pro.thaidevops.co:4433/` to work when the app is on another host, the **backend’s** TLS must be what the client sees.
- So the reverse proxy must **not** terminate TLS for the WebTransport port; it must **pass through** the QUIC/HTTPS connection to the backend (e.g. TCP or UDP passthrough to the pod’s WebTransport port).
- Then the client connects to `wt.m4pro.thaidevops.co:4433`, and the connection is forwarded to the same backend that serves `/api/config` and uses that Identity → client sees the backend cert → hash matches → **works**.

If the proxy terminates TLS at `wt.m4pro.thaidevops.co`, the backend’s cert (and thus the hash in `/api/config`) will never be seen by the client, so WebTransport will keep failing with cert errors.

### Option B: Don’t use WebTransport for that URL

- If you cannot do passthrough and cannot serve the app from the WT host, leave the WebTransport URL unset (or use a different host) so the app uses **WebSocket** only. No cert mismatch, no QUIC errors.

---

## Summary

| Project / setup | Why it works or not |
|------------------|----------------------|
| **pertisk-web-transport** local | One process; page and WT share the same Identity; hash in page = cert on 8443 → works. |
| **pertisk-web-transport** reverse (`wt2...:8443`) | Page is served from the same host/backend that serves WT; cert hash in page = cert the client sees at wt2:8443 → works. |
| **pertisk-kube-web** (app on `app...`, WT on `wt...`) | Hash is backend’s cert; client often sees proxy’s cert at `wt...` → mismatch → fails. |
| **Fix** | Use the **same cert** on both (app backend and WT server), or QUIC passthrough so the client sees the backend’s cert. |

So: the base project works because **both servers use the same cert**, so one hash works for localhost and wt2. pertisk-kube-web can do the same by using the same cert everywhere (or passthrough).

---

## Troubleshooting: localhost fails with `QUIC_TLS_CERTIFICATE_UNKNOWN`

If you see `Failed to establish a connection to https://localhost:4433/: net::ERR_QUIC_PROTOCOL_ERROR.QUIC_TLS_CERTIFICATE_UNKNOWN` even when opening the app from localhost:

1. **Same process for HTTP and WebTransport**  
   The backend that serves `/api/config` must be the **same process** that listens on `WEBTRANSPORT_PORT` (e.g. 4433). If you run the app via a dev proxy (e.g. Vite), ensure the proxy forwards `/api` to that backend. If a different process is bound to 4433, the cert hash from `/api/config` will not match that process’s cert.

2. **Backend started with WebTransport**  
   Start the backend with `WEBTRANSPORT_PORT=4433` (e.g. `make run-ingress-k8s` or `WEBTRANSPORT_PORT=4433 cargo run -p pertisk-kube-backend`). In logs you should see:  
   `WebTransport cert hash set for serverCertificateHashes (32 bytes)`.

3. **Check `/api/config`**  
   In the browser DevTools → Network, open the request to `/api/config`. The JSON should contain:
   - `webtransport_url`: e.g. `"https://localhost:4433"`
   - `webtransport_cert_hash`: an array of **32 numbers** (the SHA-256 hash).  
   If `webtransport_cert_hash` is missing, the backend did not set it (wrong binary, or WebTransport not enabled).

4. **Frontend log**  
   If the frontend has the hash, you’ll see:  
   `[realtime] Attempting WebTransport with serverCertificateHashes to https://localhost:4433`.  
   If you see `[realtime] No cert hash from /api/config ...` instead, fix the backend/config so `/api/config` returns the hash.

5. **Only one backend on 4433**  
   Stop any other process using port 4433 so the browser talks to the same backend that set the cert hash. When using `make run-ingress-k8s`, the Makefile now kills processes on 8091, 50051, and **4433** before starting, so only one backend binds to the WebTransport port.

6. **Verify the hash matches**  
   Backend logs the cert hash in hex at startup: `WebTransport cert hash set for serverCertificateHashes (hex): <64 chars>`. The frontend logs the same when attempting WebTransport: `(cert hash hex: <64 chars>)`. These two hex strings must be **identical**. You can also fetch `GET /api/webtransport-cert-hash-hex` in the browser and compare with the frontend log. If they differ, the page is getting config from a different process than the one on 4433.

7. **Try mkcert (recommended for localhost)**  
   With a self-signed cert, some browsers may still reject the connection even when `serverCertificateHashes` is set. Using **mkcert** creates a certificate that your system trusts, so the browser may accept the WebTransport connection without relying on hash pinning. Run `make certs` (requires [mkcert](https://github.com/FiloSottile/mkcert)), then start the app with `make run-ingress-k8s`. The Makefile will use `certs/localhost.pem` and `certs/localhost-key.pem` for WebTransport; the browser will trust the cert and WebTransport should connect.

---

## Troubleshooting: `wt.m4pro.thaidevops.co:4433` (or other remote URL) fails with `QUIC_TLS_CERTIFICATE_UNKNOWN`

If you see `Failed to establish a connection to https://wt.m4pro.thaidevops.co:4433/: net::ERR_QUIC_PROTOCOL_ERROR.QUIC_TLS_CERTIFICATE_UNKNOWN` (or `CERTIFICATE_VERIFY_FAILED` / certificate unknown):

1. **Who is on that host:port?**  
   The browser connects to `wt.m4pro.thaidevops.co:4433`. That must be either the **same backend** that serves `/api/config` (so the cert hash matches), or a **trusted** certificate the browser accepts without hash pinning.

2. **Passthrough (recommended for self-signed backend cert)**  
   Use **QUIC/TLS passthrough** so the connection to `wt....:4433` is forwarded to the **backend pod** without terminating TLS. The client then sees the **backend’s** certificate; `/api/config`’s `webtransport_cert_hash` is that backend’s cert hash → they match → WebTransport works.  
   - In **pt-rproxy**: add a site for the WT host with WebTransport passthrough and **UDP (and TCP) 4433** forwarded to the backend, or use L4 passthrough for 4433.  
   - Do **not** terminate TLS for the WebTransport port on the proxy, or the client will see the proxy’s cert and the hash will not match.

3. **Trusted cert on 4433**  
   If the server listening on `wt.m4pro.thaidevops.co:4433` presents a cert from a **public CA** (e.g. Let’s Encrypt) valid for that host, the browser will trust it and you don’t need hash pinning.  
   - If that server is the **backend**: set `WEBTRANSPORT_TLS_CERT` / `WEBTRANSPORT_TLS_KEY` (or in Helm `webtransport.tlsSecretName`) to that cert so the backend uses it; `/api/config` will then return the hash of that cert (optional for trusted certs).  
   - If that server is a **proxy** that terminates TLS, the proxy must use a trusted cert for `wt.m4pro.thaidevops.co`; the backend’s hash in `/api/config` will **not** match the proxy’s cert, so the frontend must either get no hash (and rely on browser trust) or you must not use a different host for the WT URL.

4. **Local dev with remote WT URL**  
   `make run-ingress-k8s` sets `WEBTRANSPORT_PUBLIC_URL=https://wt.m4pro.thaidevops.co:4433`. The **page** is loaded from your dev server (e.g. localhost); the **WebTransport** connection goes to `wt.m4pro.thaidevops.co:4433`. So the host:port must resolve to a server that presents either the **same cert** as your local backend (e.g. cluster backend with same PEM), or a **trusted** cert. If it resolves to a proxy with a different cert, use passthrough or switch to a URL that hits the backend (e.g. port-forward and `https://localhost:4433` for local testing).

---

## Setup checklist: dashboard.m4pro + wt.m4pro:4433

If your UI is **https://dashboard.m4pro.thaidevops.co/** and WebTransport is **https://wt.m4pro.thaidevops.co:4433/** and it still doesn’t work, see **[WEBTRANSPORT_M4PRO_SETUP.md](WEBTRANSPORT_M4PRO_SETUP.md)** for a step-by-step checklist (port 4433 vs 443, UDP, trusted cert, pt-rproxy relay). Use **helm/pertisk-kube/values-m4pro.yaml** as an example override.

---

## Option B: Use a trusted cert (e.g. Let's Encrypt) for WebTransport

So the **backend** presents a certificate the browser already trusts; no passthrough needed.

### 1. Get a TLS certificate for your WebTransport host

- **cert-manager (recommended)**  
  Create a Certificate or use an existing Issuer (e.g. Let's Encrypt HTTP-01 or DNS-01). Example for `wt.m4pro.thaidevops.co`:

  ```yaml
  apiVersion: cert-manager.io/v1
  kind: Certificate
  metadata:
    name: wt-m4pro-tls
    namespace: pertisk-rproxy   # same namespace as the app
  spec:
    secretName: wt-m4pro-tls    # Secret created with tls.crt + tls.key
    issuerRef:
      name: letsencrypt-prod    # or your ClusterIssuer name
      kind: ClusterIssuer
    dnsNames:
      - wt.m4pro.thaidevops.co
  ```

  Apply it and wait until the Secret `wt-m4pro-tls` exists and has `tls.crt` and `tls.key`.

- **Or** create a Secret manually from your own PEM files (e.g. from a public CA):

  ```bash
  kubectl create secret tls wt-m4pro-tls \
    --cert=path/to/fullchain.pem --key=path/to/privkey.pem \
    -n pertisk-rproxy
  ```

### 2. Point the Helm chart at that Secret

In `helm/pertisk-kube/values.yaml` (or your override file):

```yaml
app:
  webtransport:
    enabled: true
    publicUrl: "https://wt.m4pro.thaidevops.co:4433"   # or :8443 if that's the exposed port
    tlsSecretName: "wt-m4pro-tls"   # Secret from step 1 (same namespace as release)
```

- `tlsSecretName` must be the name of a Secret in the **same namespace** as the pertisk-kube release, with keys `tls.crt` and `tls.key`.
- `publicUrl` must use the hostname that matches the certificate (e.g. `wt.m4pro.thaidevops.co`) and the port that clients use (e.g. `4433` if the Service/LB exposes 4433).

### 3. Expose the WebTransport port to the internet

The backend listens on the port set in `app.service.webtransportTargetPort` (default 8443). Clients must reach that port (TCP + **UDP** for QUIC). Either:

- **Expose the app Service port** (e.g. 8443 or 4433) on your Ingress/LoadBalancer and ensure **UDP** is forwarded as well as TCP, or  
- Use a **dedicated LoadBalancer** for WebTransport: set `app.webtransport.exposeLoadBalancer: true` and set `publicUrl` to `https://wt.m4pro.thaidevops.co:<LB port>`.

### 4. Upgrade the release

```bash
helm upgrade pertisk-kube ./helm/pertisk-kube -n pertisk-rproxy -f your-values.yaml
```

After the rollout, the backend will serve WebTransport with the trusted cert. The browser will accept the connection without `serverCertificateHashes` (the cert is already trusted).
