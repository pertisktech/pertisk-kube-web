// Runtime configuration (can be overwritten in container startup).
// Default to same-origin /api when served by the Rust backend.
window.__PERTISK_CONFIG__ = {
  backendUrl: "/api",
  grpcUrl: ""   // empty = same origin (gRPC routed via ingress); override per-environment
};

