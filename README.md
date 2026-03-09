# Pertisk Kubernetes Web Dashboard

A comprehensive, real-time Kubernetes management dashboard built with Rust (Axum) backend and modern React frontend. This project provides a unified interface for monitoring and managing Kubernetes clusters with a focus on performance, security, and user experience.

This project is structured as a **single workspace**:

- `backend` – Rust service (Axum + kube-rs client) exposing a secure Kubernetes management API
- `frontend` – React SPA with real-time updates via WebSocket
- `proto` – gRPC protocol definitions for real-time resource streaming
- `helm` – Kubernetes Helm chart for production deployment

## 🎯 Core Features

### Dashboard Overview
- **Cluster Health Status** – Real-time cluster health indicators
- **Resource Utilization** – CPU, Memory, Storage, and Pod capacity monitoring (gauges and charts)
- **Node Information** – Detailed node status with allocatable resources, taints, and labels
- **Workload Summary** – Overview of Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, ReplicaSets with pie charts
- **Metrics Charts** – Interactive charts (dark green primary series) for:
  - Pod status distribution (Running, Pending, Failed, Succeeded, Unknown)
  - Node status (Ready vs NotReady)
  - Pod distribution by namespace (top 10)

### Kubernetes Resources Management

#### Workloads
- **Deployments** – Full CRUD, YAML editor, real-time pod tracking, **scale replicas**, **restart** (rollout restart)
- **StatefulSets** – Manage stateful applications with YAML editor and delete
- **DaemonSets** – Monitor daemon pods with YAML editor and delete
- **Jobs** – View and manage batch jobs with YAML editor and delete
- **CronJobs** – Scheduled job management with YAML editor and delete
- **ReplicaSets** – Replica management with YAML editor and delete
- **Pods** – List with real-time CPU/memory metrics, YAML editor, **logs** (streaming), **exec terminal**, **port-forward** (create/stop from UI), delete

#### Nodes
- **Node List & Detail** – Status, capacity, allocatable, taints, labels, annotations
- **Node Actions** – Cordon, uncordon, drain, delete; YAML get/put

#### Configuration & Secrets
- **ConfigMaps** – List, YAML get/put, view data, delete
- **Secrets** – List, YAML get/put, view data, delete
- **Resource Quotas** – List, YAML get/put, delete
- **Limit Ranges** – List, YAML get/put, delete

#### Networking
- **Services** – List, YAML get/put, delete (ClusterIP, NodePort, LoadBalancer)
- **Endpoints** – List, YAML get/put, delete
- **Ingresses** – List, YAML get/put, delete
- **Ingress Classes** – List, YAML get/put, delete
- **Network Policies** – List, YAML get/put, delete
- **Port Forwarding** – List active port-forwards, create (pod/port), stop, delete (backend-managed)

#### Storage
- **Persistent Volumes (PV)** – List, YAML get/put, delete
- **Persistent Volume Claims (PVC)** – List, YAML get/put, delete
- **Storage Classes** – List, YAML get/put, delete

#### Access Control (RBAC)
- **Service Accounts** – List, YAML get/put, delete
- **Roles** – List, YAML get/put, delete
- **Role Bindings** – List, YAML get/put, delete
- **Cluster Roles** – List, YAML get/put, delete
- **Cluster Role Bindings** – List, YAML get/put, delete

#### Config & Advanced
- **Horizontal Pod Autoscaling (HPA)** – List, YAML get/put, delete
- **Pod Disruption Budgets (PDB)** – List, YAML get/put, delete
- **Priority Classes** – List, YAML get/put, delete
- **Runtime Classes** – List, YAML get/put, delete
- **Leases** – List, YAML get/put, delete
- **Mutating/Validating Webhook Configs (MWC/VWC)** – List, YAML get/put, delete

#### Helm
- **Helm Charts** – Browse repos and charts; **install** from UI with:
  - **Values** – Default values from `helm show values`, editable YAML, then **Apply** (`helm upgrade --install`)
  - **README** – Chart README in bottom panel with **markdown viewer**
- **Helm Releases** – List by namespace; detail panel with:
  - **Revisions** – Table of revision history (revision, updated, status, chart, description)
  - **Rollback** – Rollback to a prior revision with **confirmation dialog** before running `helm rollback`
  - Upgrade release, view YAML, uninstall (with confirmation)

#### Namespaces & Events
- **Namespaces** – List, delete (with confirmation)
- **Events** – Cluster/namespace-scoped events list
- **Custom Resources (CRDs)** – List CRDs; list and manage custom resources per CRD

### Real-Time Features

#### Realtime updates (WebTransport or WebSocket)
Resource list pages use **WebTransport** when available (HTTPS + `WEBTRANSPORT_PORT` on the backend), otherwise **WebSocket** (`/ws`). Both use the same JSON protocol (subscribe / resource_update). No polling; list updates as soon as the cluster state changes.

The WebTransport URL can be set **at runtime** via backend env **`WEBTRANSPORT_PUBLIC_URL`** (e.g. in Helm: `app.webtransport.publicUrl`). The frontend fetches `GET /api/config` and uses `webtransport_url` when present; otherwise it uses the build-time **`VITE_WEBTRANSPORT_URL`**.

- **Workloads:** Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, **Pods** (list from watch; CPU/memory merged from REST)
- **Cluster:** Namespaces, **Nodes**, Events
- **Config:** ConfigMaps, Secrets, ResourceQuotas, LimitRanges, HPA, PDB, PriorityClasses, RuntimeClasses, Leases, MWC, VWC
- **Network:** Services, Endpoints, Ingresses, IngressClasses, NetworkPolicies
- **Storage:** PersistentVolumes, PersistentVolumeClaims, StorageClasses
- **RBAC:** ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings
- **Custom:** CRDs list (sidebar), custom resources per CRD  
- **Workload overview** page uses the same WebSocket hooks for all workload types.

**Pods:** Pod list is realtime via WebSocket; CPU/memory metrics come from the metrics API and are merged in (so metrics update when the pod list or REST metrics response updates).

#### Other realtime
- **Pod Exec** – Interactive shell (`/bin/sh`) via WebSocket **`/api/exec`** (bidirectional stream).
- **Token refresh** – Frontend refreshes JWT before expiry.

#### Polling (REST + refetchInterval)
- **Dashboard** – Summary and pod count from REST (no interval); **nodes** (list + metrics) polled every **30s**.
- **Nodes page** – List is WebSocket; **node metrics** (CPU/memory, `kubectl top`) polled every **30s**.
- **Helm releases** – List polled every **30s** (no WebSocket).
- **Port forwards** – List polled every **5s**.

#### Not realtime
- **Pod logs** – Single REST request returns full log output (no streaming or follow).
- **Helm charts** – Cached ~10 min; no live updates.

### Security & Authentication
- **JWT Authentication** – Login with username/password; JWT with 1-hour expiration
- **Token Refresh** – `POST /api/refresh` to extend session; frontend auto-refresh before expiry
- **Bearer Token** – Protected APIs require `Authorization: Bearer <token>`
- **RBAC** – Backend uses Kubernetes RBAC (service account / kubeconfig)
- **Secure YAML** – Edit and apply with validation

### User Interface
- **Dark / Light Theme** – Omni-inspired dark theme; system-aware light/dark
- **Responsive Layout** – Sidebar navigation, data tables, detail drawers
- **Data Tables** – Sortable, filterable; font size aligned with sidebar
- **Detail Panels** – Key/value layout; **Labels** and **Annotations** in title case; aligned key/value columns
- **Dashboard** – Gauges and charts (primary color dark green)
- **Confirm Dialogs** – Confirm before destructive actions (delete, uninstall, rollback)
- **Markdown Viewer** – Helm chart README rendered in bottom panel

## 📋 Build & Development

### Prerequisites
- Rust 1.70+ (for backend)
- Node.js 18+ (for frontend)
- Docker (optional, for deployment)
- Kubernetes cluster (1.20+)

### Build / Run (workspace root)

```bash
# build Rust backend
make build-backend
# or
cargo build -p pertisk-kube-backend

# run backend (no static files unless STATIC_DIR set)
cargo run -p pertisk-kube-backend
```

### Single-port Application (Backend + Frontend)

```bash
make run-monolith
```

Builds the React frontend and serves it from the Rust backend on a single port (default: http://localhost:8091).

### Hot Reload Development

```bash
make dev
```

- Backend hot reload uses `cargo watch` (install with `make tools` if needed)
- Frontend hot reload uses Vite dev server on `http://localhost:3000`

### Local run with Kubernetes (k8s kubeconfig)

```bash
make run-ingress-k8s
```

- Uses `K8S_KUBECONFIG` (default: `~/.kube/...` or set it) for cluster access
- Builds frontend, runs backend with static files and cargo watch; frontend build watcher runs in parallel
- Override: `make run-ingress-k8s K8S_KUBECONFIG=/path/to/kubeconfig.yaml`

## 🚀 Deployment

### Makefile (recommended)

| Target | Description |
|--------|-------------|
| `make docker-base-build` | Build base images (frontend-deps, backend-deps, runtime) from `Dockerfile.base` |
| `make docker-base-push` | Build and push base images (single-arch) |
| `make docker-base-push-multi` | Build and push multi-arch base images |
| `make docker-build` | Build app image (uses base; single-arch) |
| `make docker-build-multi` | Build and push multi-arch app image |
| `make helm-template` | Render Helm templates (no install) |
| `make helm-install` | Helm install with image tag from `DOCKER_TAG` |
| `make helm-upgrade` | Helm upgrade with `DOCKER_TAG` |
| `make helm-deploy` | Build multi-arch image and `helm upgrade --install` |
| `make release` | Same as helm-deploy (full release) |
| `make port-forward` | Forward app service to localhost (APP_PORT / GRPC_PORT) |
| `make ingress-hosts` | Print ingress host(s) for the release |
| `make lb-url` | Print LoadBalancer URL if service type is LoadBalancer |
| `make run-ingress-k8s` | Dev: frontend build watch + backend with `K8S_KUBECONFIG` |

Override defaults: `DOCKER_TAG`, `HELM_NAMESPACE`, `HELM_RELEASE`, `K8S_KUBECONFIG`, etc. See top of `Makefile`.

**Skaffold:** `make skaffold-run`, `make skaffold-run-prod`, `make skaffold-dev`, `make skaffold-delete` (use `K8S_KUBECONFIG` for kubeconfig).

### Kubernetes Deployment via Helm

```bash
# Using Make
make helm-install
# or deploy after building image
make helm-deploy

# Or manually (chart must be a path like ./helm/pertisk-kube, not just "pertisk-kube")
helm install pertisk-kube ./helm/pertisk-kube \
  -n pertisk-rproxy \
  --create-namespace \
  --set app.image.tag=latest
```

If you see `Error: non-absolute URLs should be in form of repo_name/path_to_chart, got: pertisk-kube`, use the chart **path** `./helm/pertisk-kube` (or `helm/pertisk-kube` from repo root), not the chart name alone.

### Docker

- **Base images** (Dockerfile.base): frontend-deps, backend-deps, runtime (includes kubectl, helm). Build once when deps change.
- **App image** (Dockerfile): copies built frontend and backend binary from base stages.

```bash
make docker-base-build
make docker-build
# Or multi-arch and push
make docker-build-multi
```

## 🔧 API Endpoints

All API routes are under `/api`. Protected routes require `Authorization: Bearer <JWT>` (or Basic auth).

### Public
- `GET /api/health` – Health check
- `GET /api/readiness` – Readiness check
- `POST /api/login` – Login (returns JWT, 1h expiry)

### Token
- `POST /api/refresh` – Refresh JWT (protected; extends session)

### Protected – Cluster & Compute
- `GET /api/dashboard` – Dashboard summary
- `GET /api/nodes` – List nodes
- `GET /api/nodes/:name/yaml`, `PUT /api/nodes/:name/yaml` – Node YAML
- `DELETE /api/nodes/:name` – Delete node
- `POST /api/nodes/:name/cordon` – Cordon node
- `POST /api/nodes/:name/uncordon` – Uncordon node
- `POST /api/nodes/:name/drain` – Drain node
- `GET /api/namespaces` – List namespaces
- `DELETE /api/namespaces/:name` – Delete namespace
- `GET /api/pods` – List pods
- `GET /api/pods/:namespace/:name/yaml`, `PUT /api/pods/:namespace/:name/yaml` – Pod YAML
- `DELETE /api/pods/:namespace/:name` – Delete pod
- `GET /api/pods/:namespace/:name/logs` – Pod logs (streaming)
- `GET /api/events` – List events

### Protected – Workloads
- **Deployments:** `GET /api/deployments`, `GET|PUT .../yaml`, `DELETE ...`, `POST .../scale`, `POST .../restart`
- **StatefulSets / DaemonSets / ReplicaSets / Jobs / CronJobs:** `GET` list, `GET|PUT .../yaml`, `DELETE ...`

### Protected – Config & Secrets
- **ConfigMaps:** `GET`, `GET|PUT .../yaml`, `GET .../data`, `DELETE`
- **Secrets:** `GET`, `GET|PUT .../yaml`, `GET .../data`, `DELETE`
- **ResourceQuotas / LimitRanges:** `GET`, `GET|PUT .../yaml`, `DELETE`
- **HPA / PDB:** `GET`, `GET|PUT .../yaml`, `DELETE`
- **PriorityClasses / RuntimeClasses:** `GET`, `GET|PUT .../yaml`, `DELETE`
- **Leases:** `GET`, `GET|PUT .../yaml`, `DELETE`
- **MWC / VWC:** `GET /api/mwcs`, `GET|PUT /api/mwcs/:name/yaml`, `DELETE`; same for `vwcs`

### Protected – Networking
- **Services / Endpoints / Ingresses / IngressClasses / NetworkPolicies:** `GET`, `GET|PUT .../yaml`, `DELETE`
- **Port-forward:** `GET /api/port-forwards`, `POST /api/port-forwards`, `POST /api/port-forwards/:id/stop`, `DELETE /api/port-forwards/:id`

### Protected – Storage
- **PersistentVolumes / PersistentVolumeClaims / StorageClasses:** `GET`, `GET|PUT .../yaml`, `DELETE`

### Protected – RBAC
- **ServiceAccounts / Roles / RoleBindings / ClusterRoles / ClusterRoleBindings:** `GET`, `GET|PUT .../yaml`, `DELETE`

### Protected – Generic & Helm
- `POST /api/apply` – Apply YAML manifest(s)
- **CRDs:** `GET /api/crds`, `GET /api/crds/:crd_name/resources`, `GET .../resources/:name/yaml`, `DELETE .../resources/:name`
- **Helm releases:** `GET /api/helm/releases`, `GET /api/helm/releases/:namespace/:name/yaml`, `GET .../history`, `POST .../rollback`, `POST .../upgrade`, `DELETE ...`
- **Helm charts:** `GET /api/helm/charts`, `GET /api/helm/charts/versions`, `GET /api/helm/charts/values`, `GET /api/helm/charts/readme`, `POST /api/helm/charts/install`

### Realtime (WebTransport & WebSocket)
- **WebTransport** (optional) – When `WEBTRANSPORT_PORT` is set (e.g. 4433), backend runs a WebTransport server; frontend uses it over HTTPS when supported, with WebSocket fallback.
- `WS /ws` – Real-time resource streaming (subscribe/watch; used when WebTransport is unavailable)
- `WS /api/exec` – Pod exec terminal (WebSocket only)

### Single-domain reverse proxy
Use one host and path `/` so all traffic goes through the same domain (e.g. `https://pertisk-kube.example.com/`).

- **HTTP/HTTPS:** Proxy forwards `/`, `/api`, `/assets`, etc. to the app (port 8091).
- **WebSocket:** Proxy must forward `Upgrade: websocket` for `/ws` and `/api/exec` to the same backend. The Helm ingress template sets `nginx.ingress.kubernetes.io/proxy-read-timeout`, `proxy-send-timeout`, and `websocket-services` so nginx-ingress does this when using one host and path `/`.
- **WebTransport (optional):** Path-based WebTransport (e.g. `VITE_WEBTRANSPORT_URL=/wt` → `https://host/wt`) **does not work** behind most reverse proxies: WebTransport uses HTTP/3 (QUIC), and nginx/traefik typically do not proxy WebTransport on a path, so you get "Opening handshake failed". For single-domain behind a standard proxy, **omit `VITE_WEBTRANSPORT_URL`** and use WebSocket only. To use WebTransport you can: (1) expose a **second domain** via `ingressWebtransport` (e.g. `wt.dashboard.example.com` → backend 8443; ingress controller should use TLS/QUIC passthrough for that host), or (2) expose a separate port (e.g. `https://host:8443`).

### Frontend routes (SPA)

| Path | Page |
|------|------|
| `/` | Dashboard |
| `/workloads` | Workload overview |
| `/namespaces`, `/nodes`, `/pods` | Namespaces, Nodes, Pods |
| `/deployments` … `/cronjobs` | Workload resources |
| `/config/configmaps` … `/config/leases`, `/config/mwc`, `/config/vwc` | Config & advanced |
| `/network`, `/network/services` … `/network/portforwarding` | Networking |
| `/storage`, `/storage/pvc`, `/storage/pv`, `/storage/storageclasses` | Storage |
| `/helm/charts`, `/helm/releases` | Helm charts & releases |
| `/access-control` … `/access-control/rolebindings` | RBAC |
| `/events` | Events |
| `/crds/:crdName` | Custom resources for a CRD |

## 📊 Technology Stack

### Backend
- **Rust 1.70+** - Systems programming language
- **Axum** - Ergonomic and modular web framework
- **kube-rs** - Kubernetes client library
- **Tokio** - Async runtime
- **Tonic** - gRPC framework
- **Serde** - Serialization/deserialization

### Frontend
- **React 18** - UI library
- **TypeScript** - Type-safe JavaScript
- **Vite** - Fast build tool
- **TanStack Query** - Data fetching and caching
- **Tailwind CSS** - Utility-first CSS framework
- **Recharts** - React charting library
- **Chart.js** - Data visualization
- **react-markdown** / **remark-gfm** - Markdown rendering (e.g. Helm chart README)
- **Lucide React** - Icon library

### Deployment
- **Docker** - Container images
- **Helm** - Kubernetes package manager
- **Kubernetes** - Container orchestration

## 📝 Configuration

### Environment Variables (Backend)
- `KUBECONFIG` - Path to kubeconfig file (optional, uses in-cluster config if not set)
- `PORT` - Server port (default: 8091)
- `RUST_LOG` - Log level (default: info)
- `USERNAME` - Dashboard login username (default: admin)
- `PASSWORD` - Dashboard login password (default: admin)
- `JWT_SECRET` - Secret key for JWT token signing (default: your-secret-key-change-in-production) ⚠️ **Change in production!**

### Token Expiration
- **JWT Tokens expire after 1 hour** from login
- Expired tokens automatically redirect to login page
- Re-login required after expiration

### Helm Values
- `image.tag` - Container image tag
- `replicaCount` - Number of dashboard replicas
- `resources.limits` - Resource limits
- `resources.requests` - Resource requests
- `rbac.rules` - Custom RBAC rules

## 🔐 Security

- **HTTPS Ready** - Deploy behind reverse proxy for TLS
- **JWT Authentication** - Secure login with JWT tokens (1-hour expiration)
- **Bearer Token Support** - Token-based API authentication
- **Automatic Session Expiry** - Expired tokens redirect to login
- **RBAC Compliant** - Respects Kubernetes RBAC
- **Service Account** - Uses Kubernetes service accounts for API access
- **Read-Heavy** - Mostly read-only operations (safe for monitoring)

## 💡 Usage Examples

### Scaling a Deployment

1. Navigate to **Deployments** page
2. Click on a deployment to open the detail panel
3. Scroll to "Scale Deployment" section
4. Enter the desired number of replicas (0-N)
5. Click "Scale" button
6. Deployment will scale to the specified number of pods

**API Call:**
```bash
curl -X POST http://localhost:8091/api/deployments/default/my-app/scale \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replicas": 2}'
```

### Helm release rollback

1. Go to **Helm → Releases**, select a release to open the detail panel.
2. In **Revisions**, pick a past revision and click **Rollback**.
3. Confirm in the dialog; the release rolls back to that revision (`helm rollback`).

### Authentication & Token Management

**Login and Get Token:**
```bash
curl -X POST http://localhost:8091/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin"}'
```

**Response:**
```json
{
  "success": true,
  "token": "eyJ0eXAiOiJKV1QiLCJhbGc..."
}
```

**Use Token in API Calls:**
```bash
curl http://localhost:8091/api/deployments \
  -H "Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGc..."
```

**Token Expiration:**
- Tokens expire after **1 hour** from login
- Frontend automatically detects expiry and redirects to login
- Return to login page to get a new token

## 📝 License

See LICENSE file for details.
 
