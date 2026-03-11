SHELL := /bin/sh

K8S_KUBECONFIG ?= /Users/nat/.kube/talos-omni-hz-cluister-kubeconfig.yaml
VERSION ?= $(shell V=$$(git describe --tags --always --abbrev=7 2>/dev/null || echo ""); \
	if echo "$$V" | grep -qE '^v?[0-9]+\.'; then \
		echo "$$V" | sed 's/^v//; s/-/./g'; \
	else \
		echo "1.0.0-dev"; \
	fi)
DOCKER_REGISTRY ?= harbor.tools.thaidevops.co
DOCKER_IMAGE ?= $(DOCKER_REGISTRY)/pertisksoft/pertisk-kube/web
DOCKER_TAG ?= $(VERSION)
BASE_IMAGE_PREFIX ?= $(DOCKER_REGISTRY)/pertisksoft/pertisk-kube/web-base
BASE_TAG ?= latest
HELM_RELEASE ?= pertisk-kube
HELM_NAMESPACE ?= pertisk-rproxy
# Chart path (use ./helm/pertisk-kube or repo/chart; do not use bare name or Helm errors with "non-absolute URLs")
HELM_CHART ?= ./helm/pertisk-kube
# App port (must match helm/pertisk-kube/values.yaml app.service.port)
APP_PORT ?= 8091
GRPC_PORT ?= 50051
# Local WebTransport TLS: use a matching cert+key pair (same base name). Never mix localhost.pem with wt.*-key.pem.
# Prefer wt.m4pro.thaidevops.co.pem + wt.m4pro.thaidevops.co-key.pem if both exist; else localhost.pem + localhost-key.pem (make certs).
CERTS_DIR := $(CURDIR)/certs
WT_HAVE_WT := $(and $(wildcard certs/wt.m4pro.thaidevops.co.pem),$(wildcard certs/wt.m4pro.thaidevops.co-key.pem))
WT_HAVE_LOCALHOST := $(and $(wildcard certs/localhost.pem),$(wildcard certs/localhost-key.pem))
WT_CERT_WT := $(if $(WT_HAVE_WT),WEBTRANSPORT_TLS_CERT=$(CERTS_DIR)/wt.m4pro.thaidevops.co.pem WEBTRANSPORT_TLS_KEY=$(CERTS_DIR)/wt.m4pro.thaidevops.co-key.pem,)
WT_CERT_LOCALHOST := $(if $(WT_HAVE_LOCALHOST),WEBTRANSPORT_TLS_CERT=$(CERTS_DIR)/localhost.pem WEBTRANSPORT_TLS_KEY=$(CERTS_DIR)/localhost-key.pem,)
WT_CERT_ENV := $(or $(WT_CERT_WT),$(WT_CERT_LOCALHOST))

.PHONY: dev dev-backend dev-frontend frontend-install frontend-build frontend-build-watch tools fmt build-backend run-monolith run-ingress-k8s certs check-wt-port
.PHONY: docker-build docker-build-amd64 docker-build-arm64 docker-build-multi docker-push docker-push-multi
.PHONY: docker-base-build docker-base-push docker-base-push-multi
.PHONY: helm-install helm-upgrade helm-uninstall helm-template helm-deploy port-forward ingress-hosts lb-url
.PHONY: skaffold-run skaffold-run-prod skaffold-dev skaffold-delete skaffold-build
.PHONY: release version

# Development targets
dev:
	$(MAKE) -j2 dev-backend dev-frontend

tools:
	@command -v cargo-watch >/dev/null 2>&1 || cargo install cargo-watch

dev-backend:
	@command -v cargo-watch >/dev/null 2>&1 && cargo watch -x "run -p pertisk-kube-backend" || cargo run -p pertisk-kube-backend

frontend-install:
	cd frontend && npm install

dev-frontend:
	cd frontend && npm install && npm run dev

frontend-build:
	cd frontend && npm install && npm run build

frontend-build-watch:
	cd frontend && npm install && npm run build -- --watch

fmt:
	cargo fmt

build-backend:
	cargo build -p pertisk-kube-backend

# Check if WebTransport port 8443 is in use (QUIC = UDP). Use: make check-wt-port
# On macOS netstat often does NOT show UDP listeners; use lsof. Ensure backend is running (make run-ingress-k8s) and log shows "WebTransport server listening on 0.0.0.0:8443".
check-wt-port:
	@echo "WebTransport uses UDP. Checking who uses port 8443..."
	@lsof -i :8443 2>/dev/null && true || (echo "  (none — start backend with: make run-ingress-k8s, then check log for 'WebTransport server listening')"; exit 0)
	@echo "--- netstat (macOS often omits UDP; if empty above use lsof) ---"
	@netstat -an 2>/dev/null | grep 8443 || true

# Generate trusted local TLS certs for WebTransport (https://localhost:8443). Requires mkcert (brew install mkcert && mkcert -install).
certs:
	@mkdir -p certs
	@command -v mkcert >/dev/null 2>&1 || { echo "Install mkcert: brew install mkcert && mkcert -install"; exit 1; }
	mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 ::1
	@echo "✓ certs/localhost.pem and certs/localhost-key.pem created. run-ingress-k8s will use them for WebTransport."

# Build frontend and run backend serving the built SPA on a single port.
run-monolith: frontend-build
	STATIC_DIR=frontend/dist cargo run -p pertisk-kube-backend

# Simulate running as an ingress-style controller talking to k8s via kubeconfig.
# WebTransport: WEBTRANSPORT_PUBLIC_URL=https://wt.m4pro.thaidevops.co:8443. For that URL to work
# (no QUIC_TLS_CERTIFICATE_UNKNOWN), use QUIC passthrough so client sees backend cert, or a trusted cert on 8443. See docs/WEBTRANSPORT_WHY_BASE_WORKS.md.
# Local dev with pt-rproxy passthrough: proxy on 4433 forwards to backend on 8443 (see docs/WEBTRANSPORT_M4PRO_SETUP.md):
#   (in pt-rproxy:) make dev-serve PERTISK_WT_PASSTHROUGH_ADDR=0.0.0.0:4433 PERTISK_WT_PASSTHROUGH_TARGET=127.0.0.1:8443
run-ingress-k8s: tools frontend-build
	@pkill -f "cargo-watch watch -x run -p pertisk-kube-backend" 2>/dev/null || true
	@pkill -f "target/debug/pertisk-kube-backend" 2>/dev/null || true
	@EXISTING_PIDS=$$(lsof -ti:8091 -ti:50051 -ti:8443 2>/dev/null | sort -u); \
	if [ -n "$$EXISTING_PIDS" ]; then \
		echo "Stopping existing process(es) on ports 8091/50051/8443: $$EXISTING_PIDS"; \
		echo "$$EXISTING_PIDS" | xargs kill -9; \
		sleep 1; \
	fi
	@echo "Starting frontend build watcher (npm install && npm run build -- --watch)..."
	@$(MAKE) frontend-build-watch & FRONTEND_WATCH_PID=$$!; \
	trap 'kill $$FRONTEND_WATCH_PID 2>/dev/null || true' INT TERM EXIT; \
	if [ -f "$(K8S_KUBECONFIG)" ]; then \
		echo "Using local k8s kubeconfig: $(K8S_KUBECONFIG)"; \
		$(WT_CERT_ENV) KUBECONFIG="$(K8S_KUBECONFIG)" \
		STATIC_DIR=frontend/dist \
		WEBTRANSPORT_PORT=8443 \
		WEBTRANSPORT_PUBLIC_URL=https://wt.m4pro.thaidevops.co:4433 \
		cargo watch -x 'run -p pertisk-kube-backend'; \
	else \
		echo "k8s kubeconfig not found at $(K8S_KUBECONFIG); using current kubeconfig context instead."; \
		$(WT_CERT_ENV) STATIC_DIR=frontend/dist \
		WEBTRANSPORT_PORT=8443 \
		WEBTRANSPORT_PUBLIC_URL=https://wt.m4pro.thaidevops.co:4433 \
		cargo watch -x 'run -p pertisk-kube-backend'; \
	fi

# ── Base image targets ────────────────────────────────────────────────────────
# Rebuild & push only when package.json, Cargo.toml, proto, or system tools change.
# Each stage is pushed as an independent image via --target.

docker-base-build:
	@echo "Building base images (single-arch)..."
	docker buildx build --target frontend-deps -f Dockerfile.base \
		-t $(BASE_IMAGE_PREFIX)-frontend:$(BASE_TAG) --load .
	docker buildx build --target backend-deps  -f Dockerfile.base \
		-t $(BASE_IMAGE_PREFIX)-backend:$(BASE_TAG)  --load .
	docker buildx build --target runtime        -f Dockerfile.base \
		-t $(BASE_IMAGE_PREFIX)-runtime:$(BASE_TAG)  --load .
	@echo "✓ Base images built (local): frontend / backend / runtime :$(BASE_TAG)"

docker-base-push: docker-base-build
	docker push $(BASE_IMAGE_PREFIX)-frontend:$(BASE_TAG)
	docker push $(BASE_IMAGE_PREFIX)-backend:$(BASE_TAG)
	docker push $(BASE_IMAGE_PREFIX)-runtime:$(BASE_TAG)
	@echo "✓ Base images pushed: $(BASE_IMAGE_PREFIX)-{frontend,backend,runtime}:$(BASE_TAG)"

docker-base-push-multi:
	@echo "Building & pushing multi-arch base images..."
	@set -e; \
	if ! docker buildx inspect multiarch > /dev/null 2>&1; then \
		docker buildx create --name multiarch --driver docker-container --use; \
	else \
		docker buildx use multiarch; \
	fi; \
	docker buildx inspect multiarch --bootstrap > /dev/null; \
	docker buildx build --platform linux/amd64,linux/arm64 --target frontend-deps \
		-f Dockerfile.base --push \
		-t $(BASE_IMAGE_PREFIX)-frontend:$(BASE_TAG) .; \
	docker buildx build --platform linux/amd64,linux/arm64 --target backend-deps \
		-f Dockerfile.base --push \
		-t $(BASE_IMAGE_PREFIX)-backend:$(BASE_TAG) .; \
	docker buildx build --platform linux/amd64,linux/arm64 --target runtime \
		-f Dockerfile.base --push \
		-t $(BASE_IMAGE_PREFIX)-runtime:$(BASE_TAG) .; \
	echo "✓ Multi-arch base images pushed: $(BASE_IMAGE_PREFIX)-{frontend,backend,runtime}:$(BASE_TAG)"

# ── Application image targets (fast — only recompiles changed code) ───────────
docker-build:
	docker build -f Dockerfile \
		--build-arg VERSION=$(VERSION) \
		--build-arg BASE_TAG=$(BASE_TAG) \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) .
	@echo "Built: $(DOCKER_IMAGE):$(DOCKER_TAG)"

docker-build-amd64:
	docker buildx build --platform linux/amd64 -f Dockerfile \
		--build-arg VERSION=$(VERSION) --build-arg BASE_TAG=$(BASE_TAG) \
		--load -t $(DOCKER_IMAGE):$(DOCKER_TAG)-amd64 -t $(DOCKER_IMAGE):amd64 .
	@echo "Built: $(DOCKER_IMAGE):$(DOCKER_TAG)-amd64"

docker-build-arm64:
	docker buildx build --platform linux/arm64 -f Dockerfile \
		--build-arg VERSION=$(VERSION) --build-arg BASE_TAG=$(BASE_TAG) \
		--load -t $(DOCKER_IMAGE):$(DOCKER_TAG)-arm64 -t $(DOCKER_IMAGE):arm64 .
	@echo "Built: $(DOCKER_IMAGE):$(DOCKER_TAG)-arm64"

docker-build-multi:
	@echo "Building multi-arch image: $(DOCKER_IMAGE):$(DOCKER_TAG)"
	@set -e; \
	if ! docker buildx inspect multiarch > /dev/null 2>&1; then \
		echo "Creating dedicated multiarch builder (docker-container driver)..."; \
		docker buildx create --name multiarch --driver docker-container --use; \
	else \
		docker buildx use multiarch; \
	fi; \
	docker buildx inspect multiarch --bootstrap > /dev/null; \
	echo "Using builder: multiarch"; \
	docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile \
		--build-arg VERSION=$(VERSION) --build-arg BASE_TAG=$(BASE_TAG) --push \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) \
		-t $(DOCKER_IMAGE):latest .; \
	echo "✓ Built and pushed multi-arch: $(DOCKER_IMAGE):$(DOCKER_TAG)"

docker-push:
	docker push $(DOCKER_IMAGE):$(DOCKER_TAG)
	@echo "Pushed: $(DOCKER_IMAGE):$(DOCKER_TAG)"

docker-push-multi: docker-build-multi
	@echo "✓ Multi-arch image pushed: $(DOCKER_IMAGE):$(DOCKER_TAG)"

# Helm targets
helm-template:
	helm template $(HELM_RELEASE) $(HELM_CHART) -n $(HELM_NAMESPACE)

helm-install:
	helm install $(HELM_RELEASE) $(HELM_CHART) -n $(HELM_NAMESPACE) --create-namespace \
		--set app.image.tag=$(DOCKER_TAG)
	@echo "✓ Installed $(HELM_RELEASE) with version $(DOCKER_TAG)"

helm-upgrade:
	helm upgrade $(HELM_RELEASE) $(HELM_CHART) -n $(HELM_NAMESPACE) \
		--set app.image.tag=$(DOCKER_TAG)
	@echo "✓ Upgraded $(HELM_RELEASE) to version $(DOCKER_TAG)"

helm-uninstall:
	helm uninstall $(HELM_RELEASE) -n $(HELM_NAMESPACE)
	@echo "✓ Uninstalled $(HELM_RELEASE)"

# List ingress domains (app URL) for the remote cluster. Use https://<host> to access the app. No port-forward.
ingress-hosts:
	@echo "App URL(s) in $(HELM_NAMESPACE) (remote cluster — use https://<host> or http://<host>):"
	@kubectl get ingress -n $(HELM_NAMESPACE) -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}' 2>/dev/null | sort -u | sed 's/^/  /' || echo "  (no ingresses or namespace missing)"

# LoadBalancer URL: show http://<EXTERNAL-IP>:<port> when service type is LoadBalancer. Run after deploy.
lb-url:
	@IP=$$(kubectl get svc -n $(HELM_NAMESPACE) $(HELM_RELEASE) -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null); \
	if [ -z "$$IP" ]; then \
		IP=$$(kubectl get svc -n $(HELM_NAMESPACE) $(HELM_RELEASE) -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null); \
	fi; \
	if [ -z "$$IP" ]; then \
		echo "LoadBalancer IP not ready yet (or service is not type LoadBalancer). Run: kubectl get svc -n $(HELM_NAMESPACE) $(HELM_RELEASE)"; \
	else \
		echo "App URL (LoadBalancer): http://$$IP:$(APP_PORT)"; \
		echo "  (gRPC: $$IP:$(GRPC_PORT))"; \
	fi

# Local/dev only: forward app port to localhost. Not for remote cluster access — use Ingress URL (make ingress-hosts).
port-forward:
	@echo "Forwarding $(HELM_NAMESPACE)/$(HELM_RELEASE) -> localhost:$(APP_PORT) (http), localhost:$(GRPC_PORT) (grpc). Ctrl+C to stop."
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE) $(APP_PORT):$(APP_PORT) $(GRPC_PORT):$(GRPC_PORT)

# Build, push multi-arch Docker image and deploy with Helm
helm-deploy: docker-build-multi
	@echo "Deploying pertisk-kube with image tag $(DOCKER_TAG)..."
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) -n $(HELM_NAMESPACE) \
		--create-namespace \
		--set app.image.tag=$(DOCKER_TAG)
	@echo "✓ Deployed pertisk-kube version $(DOCKER_TAG)"

# Complete release: build multi-arch and deploy
release: docker-build-multi helm-deploy
	@echo "✓ Released version $(VERSION)"

# Skaffold targets
# Run once: build, push, and deploy to Kubernetes
skaffold-run:
	@FOUR_DIGIT_TAG=$$(( (RANDOM % 9000) + 1000 )); \
	echo "Using FOUR_DIGIT_TAG=$$FOUR_DIGIT_TAG"; \
	FOUR_DIGIT_TAG=$$FOUR_DIGIT_TAG skaffold run --kubeconfig=$(K8S_KUBECONFIG)

# Run once with production profile (git tag versioning + prod values)
skaffold-run-prod:
	skaffold run -p prod --kubeconfig=$(K8S_KUBECONFIG)

# Watch mode: rebuild and redeploy on source changes
skaffold-dev:
	skaffold dev --kubeconfig=$(K8S_KUBECONFIG)

# Build and push the image only (no deploy)
skaffold-build:
	skaffold build

# Tear down the Helm release deployed by Skaffold
skaffold-delete:
	skaffold delete --kubeconfig=$(K8S_KUBECONFIG)

# Show current version from git
version:
	@echo "$(VERSION)"

# Setup buildx for multi-platform builds (required for docker-build-multi on macOS/OrbStack)
buildx-setup:
	@echo "Setting up Docker buildx for multi-platform builds..."
	@if docker buildx inspect multiarch > /dev/null 2>&1; then \
		echo "✓ multiarch builder already exists"; \
		docker buildx use multiarch; \
	else \
		echo "Creating multiarch builder..."; \
		docker buildx create --name multiarch --driver docker-container --use; \
		docker buildx inspect multiarch --bootstrap; \
	fi
	@echo "✓ Buildx ready for multi-platform builds"

