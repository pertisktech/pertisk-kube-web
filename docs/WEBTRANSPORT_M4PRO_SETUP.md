# WebTransport setup: dashboard.m4pro.thaidevops.co + wt.m4pro.thaidevops.co:4433

UI: **https://dashboard.m4pro.thaidevops.co/**  
WebTransport: **https://wt.m4pro.thaidevops.co:4433/**

---

## Local reverse proxy (dashboard and WT on your machine)

When you run a **local** reverse proxy (e.g. pt-rproxy, Caddy, or `make run-ingress-k8s` with dashboard/WT hostnames pointing to 127.0.0.1):

- **dashboard.m4pro.thaidevops.co** → proxy → backend (e.g. :8091).
- **wt.m4pro.thaidevops.co:4433** → must reach the **same backend** that serves `/api/config`, and the browser must see the **backend’s** certificate (so the hash matches). If the proxy **terminates TLS** for :4433 and presents its own cert, the browser sees the proxy’s cert and you get `QUIC_TLS_CERTIFICATE_UNKNOWN` (hash from `/api/config` is the backend’s cert, not the proxy’s).

**Option A – :4433 must hit the backend directly (no TLS termination in between)**

When DNS is correct (no need to set `/etc/hosts`), the important part is **what** serves wt.m4pro.thaidevops.co:4433:

1. **Do not** have the reverse proxy **terminate TLS** for port 4433. If the proxy accepts HTTPS on 4433 and presents its own certificate, the browser sees the proxy’s cert and the hash from `/api/config` (backend’s cert) will not match → `QUIC_TLS_CERTIFICATE_UNKNOWN`.
2. Either:
   - **Passthrough:** the proxy forwards **raw TCP/UDP** to the backend on 4433 (no TLS termination). Then the browser talks TLS directly to the backend → same cert and hash → connection works; or
   - **No proxy on 4433:** wt.m4pro.thaidevops.co:4433 resolves to the **backend** (e.g. LoadBalancer or direct to the app). Only the backend listens on 4433 and does TLS.
3. **UDP:** WebTransport uses QUIC (UDP). The path to the backend on 4433 must forward **UDP** as well as TCP.

**Option B – Trusted cert at wt.m4pro:4433**

- Have the server that responds at wt.m4pro.thaidevops.co:4433 use a certificate from a **public CA** (e.g. Let’s Encrypt) for that host. Then the browser trusts it and you don’t rely on hash pinning. Configure the backend (or the proxy, if it terminates TLS there) with that cert.

**If the proxy handles wt.m4pro:4433**

- The proxy must **not** terminate TLS for that host:port; it must **pass through** TCP and **UDP** to the backend. Then the client sees the backend’s cert and the hash matches. If the proxy cannot do UDP passthrough for 4433, expose the backend’s WebTransport port directly (e.g. separate Service/LB) or use a trusted cert (Option B).

---

## Local dev: run backend + pt-rproxy with passthrough (no Kubernetes deploy)

When you run **pertisk-kube-web** locally (`make run-ingress-k8s`) and **pt-rproxy** (ingress) locally, use **L4 passthrough** so the proxy forwards wt.m4pro:4433 to your backend without terminating TLS. The proxy must listen on **4433** and the backend on a **different** port (e.g. **8443**) so they don’t conflict.

**1. Terminal 1 – backend (pertisk-kube-web) on 8443**

```bash
cd /path/to/pertisk-kube-web
WEBTRANSPORT_PORT=8443 \
WEBTRANSPORT_PUBLIC_URL=https://wt.m4pro.thaidevops.co:4433 \
make run-ingress-k8s
```

Backend listens on 8091 (HTTP) and **8443** (WebTransport). `WEBTRANSPORT_PUBLIC_URL` is the URL the browser uses (proxy port 4433).

**2. Terminal 2 – reverse proxy (pt-rproxy) with passthrough on 4433**

```bash
cd /path/to/pt-rproxy
make dev-serve \
  PERTISK_WT_PASSTHROUGH_ADDR=0.0.0.0:4433 \
  PERTISK_WT_PASSTHROUGH_TARGET=127.0.0.1:8443
```

pt-rproxy (standalone proxy with `dev-serve`) listens on **4433** (TCP+UDP) and forwards raw traffic to **127.0.0.1:8443** (your backend). No TLS termination → browser’s TLS is to the backend → cert hash from `/api/config` matches.

**3. DNS and ports**

- **dashboard.m4pro.thaidevops.co** and **wt.m4pro.thaidevops.co** resolve to the machine where pt-rproxy runs. pt-rproxy is reachable on **80/443** (or 18080/18443) for the dashboard and on **4433** for WebTransport.

**4. Result**

- UI: dashboard.m4pro → proxy → backend:8091  
- WT: wt.m4pro:4433 → proxy:4433 (passthrough) → backend:8443 → same backend cert, hash matches → WebTransport works.

**If you still see QUIC_TLS_CERTIFICATE_UNKNOWN** with passthrough, the browser is probably **not** hitting your local proxy:

- **wt.m4pro.thaidevops.co** must resolve to the **same machine** where `make dev-serve` runs. If it resolves to a remote IP (e.g. cluster), the connection goes there and your local passthrough is never used.
- **For local dev only:** add to `/etc/hosts`: `127.0.0.1  wt.m4pro.thaidevops.co` so the browser connects to your local proxy on 4433. Remove it when you’re done testing.
- **Or** use **https://localhost:4433** as the WebTransport URL: run the backend with `WEBTRANSPORT_PORT=4433` and `WEBTRANSPORT_PUBLIC_URL=https://localhost:4433` (no proxy on 4433), and use `make certs` (mkcert) so the browser trusts the cert.

---

## ERR_QUIC_PROTOCOL_ERROR.QUIC_TLS_CERTIFICATE_UNKNOWN – verify these

The error means the browser rejected the certificate at **wt.m4pro.thaidevops.co:4433**. Work through these in order.

### 1. Secret exists and is mounted in the pod

The backend must get the cert from the Secret. If the Secret is missing or not mounted, the backend falls back to a **self-signed** cert; then the hash in `/api/config` can still match, but only if the **same** backend is reached at 4433 with **no proxy** in between. If a proxy terminates TLS, the client sees the proxy’s cert and the hash will not match.

```bash
# Replace namespace and release name as needed
kubectl get secret wt-m4pro-tls -n pertisk-rproxy
kubectl get pods -n pertisk-rproxy -l app=pertisk-kube
kubectl describe pod <one-pod-name> -n pertisk-rproxy | grep -A5 "webtransport-tls\|WEBTRANSPORT_TLS"
```

You should see:
- Secret `wt-m4pro-tls` exists (or whatever you set in `app.webtransport.tlsSecretName`).
- Pod has volume `webtransport-tls` and env `WEBTRANSPORT_TLS_CERT=/app/certs/wt/tls.crt`, `WEBTRANSPORT_TLS_KEY=/app/certs/wt/tls.key`.

If the volume or env is missing, fix Helm values so `app.webtransport.tlsSecretName` is set and the release is in the **same namespace** as the Secret.

### 2. Backend logs show the cert is loaded

After rollout, check backend logs:

```bash
kubectl logs -n pertisk-rproxy deployment/pertisk-kube -c pertisk-kube --tail=100 | grep -i webtransport
```

You must see:
- **"WebTransport using TLS cert from PEM: /app/certs/wt/tls.crt"** – cert from the Secret is used.
- **"WebTransport cert hash set for serverCertificateHashes (hex): …"** – hash is set for the frontend.

If you see **"WebTransport using self-signed cert"** instead, the Secret is not mounted or the env vars are wrong.

### 3. /api/config returns the cert hash

Open the dashboard (https://dashboard.m4pro.thaidevops.co/), DevTools → Network, find the request to **/api/config**. The JSON should contain:

- `"webtransport_url": "https://wt.m4pro.thaidevops.co:4433"`
- `"webtransport_cert_hash": [ … ]` (array of 32 numbers)

If `webtransport_cert_hash` is missing, the backend that served the page did not set the hash (wrong binary, or WebTransport not enabled / cert not loaded).

### 4. Traffic to :4433 reaches the backend (no TLS proxy in between)

If something in front of the backend (e.g. another proxy or Ingress) **terminates TLS** for wt.m4pro:4433, the browser sees **that** certificate, not the backend’s. The hash in `/api/config` is the backend’s cert, so it will not match and you get CERTIFICATE_VERIFY_FAILED.

- **Required:** Requests to **wt.m4pro.thaidevops.co:4433** must go **directly to the pertisk-kube pods** (e.g. via a LoadBalancer Service that targets those pods), with **no TLS termination** in between. The backend does TLS itself.
- **UDP:** WebTransport uses QUIC (UDP). The LoadBalancer (and any firewall) must forward **UDP** on the WebTransport port (4433 or 8443), not only TCP.

Quick check: open **https://wt.m4pro.thaidevops.co:4433/** in a **new browser tab**. If the connection fails or the certificate shown is for a different host or issuer, then either the connection is not reaching the backend or a proxy is terminating TLS.

### 5. DNS for wt.m4pro points at the right place

**wt.m4pro.thaidevops.co** must resolve to the **external IP of the Service that exposes the WebTransport port** (the one that forwards to the pertisk-kube pods). If you use `exposeLoadBalancer: true`, that is the WebTransport LoadBalancer’s IP, not the main app’s LoadBalancer IP (unless they are the same).

---

## Why it still doesn’t work – quick checklist

### 1. Port 4433 must reach the backend (and use UDP for QUIC)

- **Normal Ingress only listens on 80/443.** So `wt.m4pro.thaidevops.co:4433` does **not** go through a standard Ingress. You need one of:
  - **A. LoadBalancer for WebTransport**  
    In pertisk-kube Helm set `app.webtransport.exposeLoadBalancer: true`. That creates a **separate** Service (LoadBalancer) exposing the WebTransport port. Set `app.service.webtransportPort: 4433` if you want the public port to be 4433 (otherwise the default 8443 is used). Point **wt.m4pro.thaidevops.co** DNS to that LoadBalancer’s external IP.
  - **B. Proxy on 443 (recommended)**  
    Use **port 443** for WebTransport so you don’t need 4433 at all: set `app.webtransport.publicUrl: "https://wt.m4pro.thaidevops.co"` (no `:4433`). Configure **pt-rproxy** (pertisk-ingress) with a site for **wt.m4pro.thaidevops.co** with **WebTransport relay** to the backend. Then the browser uses `https://wt.m4pro.thaidevops.co` (port 443); the proxy relays QUIC to the backend. **UDP 443** must reach the proxy (and the proxy must advertise HTTP/3 / WebTransport).

### 2. UDP must be forwarded

- WebTransport uses **QUIC = UDP**. If only TCP is forwarded to the backend (or proxy), the handshake never completes and you get timeouts or cert errors.
- **LoadBalancer:** The WebTransport Service is UDP. Ensure your cloud LB or MetalLB forwards **UDP** on the WebTransport port (4433 or 8443), not only TCP.
- **pt-rproxy on 443:** The proxy’s Service must expose **UDP 443** (e.g. `service.http3Port: 443` in pertisk-ingress values) and the external LB must forward **UDP 443** to the proxy.

### 3. Certificate the browser sees

- **Option B (trusted cert):** The server that responds at `wt.m4pro.thaidevops.co:4433` (or `:443`) must present a certificate valid for **wt.m4pro.thaidevops.co** and issued by a CA the browser trusts (e.g. Let’s Encrypt).
  - If that server is the **backend:** set `app.webtransport.tlsSecretName` to a Secret that contains that cert (`tls.crt` + `tls.key`), in the same namespace as the release.
  - If that server is **pt-rproxy** (relay on 443): the proxy’s CertStore must have a trusted cert for **wt.m4pro.thaidevops.co** (e.g. from an Ingress TLS Secret or cert-manager).
- **Option A (passthrough):** The connection to wt.m4pro must be **passed through** to the backend without TLS termination, so the client sees the **backend’s** cert and the hash from `/api/config` matches.

### 4. Same app for dashboard and WebTransport

- The backend that serves **dashboard.m4pro.thaidevops.co** (and thus `/api/config`) must be the **same** app that serves WebTransport for **wt.m4pro.thaidevops.co**. So the same Helm release (pertisk-kube) should have:
  - Ingress (or pt-rproxy site) for **dashboard.m4pro.thaidevops.co** → app port 8091.
  - WebTransport reachable at **wt.m4pro.thaidevops.co** (either via LoadBalancer on 4433/8443 or via pt-rproxy relay on 443) → same app’s WebTransport port (8443 in-cluster).

---

## Recommended: use port 443 with pt-rproxy (no 4433)

1. **pertisk-kube Helm** (values override):
   ```yaml
   app:
     webtransport:
       enabled: true
       publicUrl: "https://wt.m4pro.thaidevops.co"   # no :4433
       tlsSecretName: "wt-m4pro-tls"   # Secret with trusted cert for wt.m4pro.thaidevops.co
   ```

2. **pt-rproxy (pertisk-ingress):** Add a site (or PertiskIngress) for **wt.m4pro.thaidevops.co** with:
   - WebTransport passthrough/relay enabled.
   - Backend = the pertisk-kube Service, port 8443 (WebTransport).
   - TLS: use a Secret that has a **trusted** cert for wt.m4pro.thaidevops.co (so the proxy presents that cert on 443 for that host).

3. **Network:** Ensure **UDP 443** is forwarded to the pt-rproxy LoadBalancer (MetalLB or cloud LB that supports UDP).

4. **DNS:** **wt.m4pro.thaidevops.co** must resolve to the same LB (or same IP) as the proxy’s HTTPS (e.g. dashboard and wt on the same front-end).

Then the frontend uses `https://wt.m4pro.thaidevops.co` (port 443); no custom port 4433 needed.

---

## If you keep using port 4433

1. **Expose 4433 on a LoadBalancer**
   - In pertisk-kube values: `app.webtransport.exposeLoadBalancer: true`, and set `app.service.webtransportPort: 4433` so the Service (and LB) listen on 4433.
   - Ensure the WebTransport Service is **UDP** (the chart already uses protocol: UDP for the WT port).

2. **DNS**
   - **wt.m4pro.thaidevops.co** must resolve to the **external IP of the WebTransport LoadBalancer** (the one that exposes 4433), not the dashboard’s LB.

3. **Trusted cert on the backend**
   - Create a Secret (e.g. from cert-manager) with a cert for **wt.m4pro.thaidevops.co**.
   - Set `app.webtransport.tlsSecretName: "wt-m4pro-tls"` (or whatever the Secret name is).

4. **UDP 4433**
   - The LoadBalancer and any firewall must allow **UDP 4433** to the backend, not only TCP.

After that, reload the dashboard and try again; the browser should connect to `https://wt.m4pro.thaidevops.co:4433/` and see the backend’s trusted cert.
