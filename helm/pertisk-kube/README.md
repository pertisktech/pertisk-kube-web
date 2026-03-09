# Pertisk Kube Helm Chart

This Helm chart deploys the Pertisk Kubernetes Web Application as a unified deployment, which provides a dashboard for monitoring Kubernetes resources. The backend serves both API and frontend static files in a single container.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- kubectl configured to communicate with your cluster

## Installation

### 1. Build Docker Image

The unified Dockerfile builds both frontend and backend in a single image:

```bash
# Build unified image
docker build -f Dockerfile -t your-registry/pertisk-kube:latest .
docker push your-registry/pertisk-kube:latest
```

### 2. Update values.yaml

Edit `values.yaml` and update the image repository:

```yaml
app:
  image:
    repository: your-registry/pertisk-kube
    tag: latest

ingress:
  hosts:
    - host: your-domain.com
```

### 3. Install the Chart

```bash
# Install with default values
helm install pertisk-kube ./helm/pertisk-kube -n pertisk-rproxy --create-namespace

# Or use upgrade --install for idempotent deployment
helm upgrade --install pertisk-kube ./helm/pertisk-kube -n pertisk-rproxy --create-namespace

# Install with custom values
helm install pertisk-kube ./helm/pertisk-kube -f custom-values.yaml -n pertisk-rproxy --create-namespace
```

## Configuration

The following table lists the configurable parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `namespace.create` | Create the namespace via template (prefer `--create-namespace` flag instead) | `false` |
| `app.replicaCount` | Number of replicas | `1` |
| `app.image.repository` | Image repository | `your-registry/pertisk-kube` |
| `app.image.tag` | Image tag | `latest` |
| `app.service.port` | Service port | `8091` |
| `app.env.rustLog` | Rust logging level | `info` |
| `app.webtransport.enabled` | Enable WebTransport server | `false` |
| `app.webtransport.publicUrl` | Public WebTransport URL (frontend reads from `/api/config`; env `WEBTRANSPORT_PUBLIC_URL`) | `""` |
| `app.webtransport.tlsSecretName` | Secret name for WebTransport TLS (must have `tls.crt` and `tls.key`; same idea as local certs/) | `""` |
| `app.webtransport.exposeLoadBalancer` | Create a second Service (LoadBalancer) exposing only 50052/UDP for direct WebTransport access | `false` |
| `ingress.enabled` | Enable ingress | `true` |
| `ingress.hosts` | Ingress hosts | `[pertisk-kube.example.com]` |
| `rbac.create` | Create RBAC resources | `true` |

## Upgrading

```bash
# Upgrade the release
helm upgrade pertisk-kube ./helm/pertisk-kube -n pertisk-rproxy

# Upgrade with new values
helm upgrade pertisk-kube ./helm/pertisk-kube -f new-values.yaml -n pertisk-rproxy
```

## Uninstalling

```bash
# Uninstall the release
helm uninstall pertisk-kube -n pertisk-rproxy

# Uninstall and delete namespace
helm uninstall pertisk-kube -n pertisk-rproxy
kubectl delete namespace pertisk-rproxy
```

## Accessing the Application

After installation, you can access the application:

1. **Via Ingress** (if enabled):
   - Access at the configured hostname (e.g., https://pertisk-kube.example.com)

2. **Via Port Forward**:
   ```bash
   kubectl port-forward -n pertisk-rproxy svc/pertisk-kube 8080:8091
   ```
   Then access at http://localhost:8080

## Troubleshooting

Check pod status:
```bash
kubectl get pods -n pertisk-rproxy
```

View logs:
```bash
kubectl logs -n pertisk-rproxy -l app=pertisk-kube -f
```

Describe resources:
```bash
kubectl describe deployment -n pertisk-rproxy pertisk-kube
```
