#!/bin/sh
set -eu

# Runtime config for the SPA.
# This avoids having to rebuild the image to change backend URL.
BACKEND_URL="${BACKEND_URL:-http://pertisk-kube-backend.pertisk-kube.svc.cluster.local:8091/api}"
# Empty string means "same origin via ingress" — override to explicit URL when
# the gRPC service is not routed through the same ingress host.
GRPC_URL="${GRPC_URL:-}"

cat > /app/dist/config.js <<EOF
window.__PERTISK_CONFIG__ = { backendUrl: "${BACKEND_URL}", grpcUrl: "${GRPC_URL}" };
EOF

exec serve -s /app/dist -l 3000

