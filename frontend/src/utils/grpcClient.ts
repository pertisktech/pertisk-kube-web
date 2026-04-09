import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { KubernetesWatch } from "../gen/kubernetes_pb.js";

function getGrpcUrl(): string {
  const cfg = (window as Window & typeof globalThis & { __PERTISK_CONFIG__?: { grpcUrl?: string } }).__PERTISK_CONFIG__;
  if (cfg?.grpcUrl) return cfg.grpcUrl;
  // In vite dev the proxy forwards /kubernetes.* to the gRPC server.
  // In monolith mode GRPC_URL is injected into config.js by the backend.
  // In production, the ingress routes /kubernetes.* to the gRPC service on the same origin.
  return window.location.origin;
}

let _client: ReturnType<typeof createClient<typeof KubernetesWatch>> | null = null;

export function getKubeWatchClient() {
  if (!_client) {
    const transport = createGrpcWebTransport({ baseUrl: getGrpcUrl() });
    _client = createClient(KubernetesWatch, transport);
  }
  return _client;
}
