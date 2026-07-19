SHELL := /bin/sh

K8S_KUBECONFIG ?=/Users/nat/.kube/omni-proxmox-285h-kubeconfig.yaml
K8S_KUBECONFIG_TALOS ?= /Users/nat/.kube/omni-proxmox-285h-kubeconfig.yaml
K8S_KUBECONFIG_TALOS_HZ ?= /Users/nat/.kube/hetznet-kubeadm-cluster.yaml
K8S_KUBECONFIG_ORION ?= /Users/nat/.kube/orion-kubeadm-cluster.yaml
VERSION ?= $(shell V=$$(git describe --tags --always --abbrev=7 2>/dev/null || echo ""); \
	if echo "$$V" | grep -qE '^v?[0-9]+\.'; then \
		echo "$$V" | sed 's/^v//; s/-/./g'; \
	else \
		echo "1.0.0-dev"; \
	fi)
DOCKER_REGISTRY ?= harbor.tools.thaidevops.co
DOCKER_IMAGE ?= $(DOCKER_REGISTRY)/pertisksoft/pertisk-kube/web
IMAGE_TAG ?=
DOCKER_TAG ?= $(if $(IMAGE_TAG),$(IMAGE_TAG),$(VERSION))
BUILD_VERSION ?= $(DOCKER_TAG)
BASE_IMAGE_PREFIX ?= $(DOCKER_REGISTRY)/pertisksoft/pertisk-kube/web-base
BASE_TAG ?= latest
HELM_RELEASE ?= pertisk-kube
HELM_NAMESPACE ?= pertisk-rproxy
HELM_CHART_DIR ?= ./helm/pertisk-kube
HELM_PACKAGE_DIR ?= ./dist/helm
HELM_OCI_REGISTRY ?= $(DOCKER_REGISTRY)
HELM_OCI_REPOSITORY ?= pertisksoft/helm-charts
# Local app ports (keep different from pertisk-kube-app defaults)
# Kubernetes/Helm service ports remain defined in helm values.
APP_PORT ?= 8091
GRPC_PORT ?= 50061

.PHONY: dev dev-backend dev-frontend frontend-install frontend-build frontend-build-watch tools fmt build-backend run-monolith run-ingress-k8s
.PHONY: docker-build docker-build-amd64 docker-build-arm64 docker-build-multi docker-push docker-push-multi
.PHONY: docker-base-build docker-base-push docker-base-push-multi
.PHONY: helm-install helm-upgrade helm-uninstall helm-template helm-deploy port-forward ingress-hosts lb-url
.PHONY: helm-lint helm-package helm-push helm-release
.PHONY: skaffold-run skaffold-run-talos skaffold-run-talos-hz skaffold-run-orion skaffold-run-orion-multi skaffold-run-orion-arm64 _skaffold-run skaffold-run-prod skaffold-dev skaffold-delete skaffold-build skaffold-build-multi
.PHONY: release version

# Development targets
dev:
	$(MAKE) -j2 dev-backend dev-frontend

tools:
	@command -v cargo-watch >/dev/null 2>&1 || cargo install cargo-watch

dev-backend:
	@command -v cargo-watch >/dev/null 2>&1 && APP_PORT=$(APP_PORT) GRPC_PORT=$(GRPC_PORT) cargo watch -x "run -p pertisk-kube-backend" || APP_PORT=$(APP_PORT) GRPC_PORT=$(GRPC_PORT) cargo run -p pertisk-kube-backend

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

# Build frontend and run backend serving the built SPA on a single port.
run-monolith: frontend-build
	APP_PORT=$(APP_PORT) GRPC_PORT=$(GRPC_PORT) STATIC_DIR=frontend/dist cargo run -p pertisk-kube-backend

# Simulate running as an ingress-style controller talking to k8s via kubeconfig.
run-ingress-k8s: tools frontend-build
	@EXISTING_PIDS=$$(lsof -ti:$(APP_PORT) -ti:$(GRPC_PORT) 2>/dev/null | sort -u); \
	if [ -n "$$EXISTING_PIDS" ]; then \
			echo "Stopping existing process(es) on ports $(APP_PORT)/$(GRPC_PORT): $$EXISTING_PIDS"; \
		echo "$$EXISTING_PIDS" | xargs kill -9; \
		sleep 1; \
	fi
	@echo "Starting frontend build watcher (npm install && npm run build -- --watch)..."
	@$(MAKE) frontend-build-watch & FRONTEND_WATCH_PID=$$!; \
	trap 'kill $$FRONTEND_WATCH_PID 2>/dev/null || true' INT TERM EXIT; \
	if [ -f "$(K8S_KUBECONFIG)" ]; then \
		echo "Using local k8s kubeconfig: $(K8S_KUBECONFIG)"; \
		KUBECONFIG="$(K8S_KUBECONFIG)" \
		APP_PORT=$(APP_PORT) GRPC_PORT=$(GRPC_PORT) \
		STATIC_DIR=frontend/dist \
		cargo watch \
			-i frontend/dist \
			-i frontend/node_modules \
			-i target \
			-w backend/src \
			-w backend/Cargo.toml \
			-w Cargo.toml \
			-w proto \
			-x 'run -p pertisk-kube-backend'; \
	else \
		echo "k8s kubeconfig not found at $(K8S_KUBECONFIG); using current kubeconfig context instead."; \
		APP_PORT=$(APP_PORT) GRPC_PORT=$(GRPC_PORT) \
		STATIC_DIR=frontend/dist \
		cargo watch \
			-i frontend/dist \
			-i frontend/node_modules \
			-i target \
			-w backend/src \
			-w backend/Cargo.toml \
			-w Cargo.toml \
			-w proto \
			-x 'run -p pertisk-kube-backend'; \
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
		--build-arg VERSION=$(BUILD_VERSION) \
		--build-arg BASE_TAG=$(BASE_TAG) \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) .
	@echo "Built: $(DOCKER_IMAGE):$(DOCKER_TAG)"

docker-build-amd64:
	docker buildx build --platform linux/amd64 -f Dockerfile \
		--build-arg VERSION=$(BUILD_VERSION) --build-arg BASE_TAG=$(BASE_TAG) \
		--load -t $(DOCKER_IMAGE):$(DOCKER_TAG)-amd64 -t $(DOCKER_IMAGE):amd64 .
	@echo "Built: $(DOCKER_IMAGE):$(DOCKER_TAG)-amd64"

docker-build-arm64:
	docker buildx build --platform linux/arm64 -f Dockerfile \
		--build-arg VERSION=$(BUILD_VERSION) --build-arg BASE_TAG=$(BASE_TAG) \
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
		--provenance=false --sbom=false \
		--build-arg VERSION=$(BUILD_VERSION) --build-arg BASE_TAG=$(BASE_TAG) --push \
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
	helm template $(HELM_RELEASE) $(HELM_CHART_DIR) -n $(HELM_NAMESPACE)

helm-install:
	helm install $(HELM_RELEASE) $(HELM_CHART_DIR) -n $(HELM_NAMESPACE) --create-namespace \
		--set app.image.tag=$(DOCKER_TAG)
	@echo "✓ Installed $(HELM_RELEASE) with version $(DOCKER_TAG)"

helm-upgrade:
	helm upgrade $(HELM_RELEASE) $(HELM_CHART_DIR) -n $(HELM_NAMESPACE) \
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
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART_DIR) -n $(HELM_NAMESPACE) \
		--create-namespace \
		--set app.image.tag=$(DOCKER_TAG)
	@echo "✓ Deployed pertisk-kube version $(DOCKER_TAG)"

# Validate the chart before packaging.
helm-lint:
	helm lint $(HELM_CHART_DIR)

# Package chart into HELM_PACKAGE_DIR and print artifact path.
helm-package: helm-lint
	@mkdir -p $(HELM_PACKAGE_DIR)
	@PKG=$$(helm package $(HELM_CHART_DIR) \
		--version $(VERSION) \
		--app-version $(DOCKER_TAG) \
		-d $(HELM_PACKAGE_DIR) | awk '{print $$NF}'); \
	echo "✓ Chart packaged: $$PKG"

# Push latest packaged chart archive to OCI registry.
# Requires registry auth (run: helm registry login <registry>). 
helm-push: helm-package
	@PKG=$$(ls -1t $(HELM_PACKAGE_DIR)/*.tgz 2>/dev/null | head -n1); \
	if [ -z "$$PKG" ]; then \
		echo "No packaged chart found in $(HELM_PACKAGE_DIR)"; \
		exit 1; \
	fi; \
	echo "Pushing $$PKG to oci://$(HELM_OCI_REGISTRY)/$(HELM_OCI_REPOSITORY)"; \
	helm push "$$PKG" "oci://$(HELM_OCI_REGISTRY)/$(HELM_OCI_REPOSITORY)"; \
	echo "✓ Chart pushed: oci://$(HELM_OCI_REGISTRY)/$(HELM_OCI_REPOSITORY)"

# Full Helm chart release flow: lint -> package -> push.
helm-release: helm-push
	@echo "✓ Helm chart release complete"

# Complete release: build multi-arch and deploy
release: docker-build-multi helm-deploy
	@echo "✓ Released version $(VERSION)"

# Skaffold targets
# Run once: build and push with Skaffold, then deploy with Helm.
_skaffold-run:
	@set -e; \
	FOUR_DIGIT_TAG=$$(( (RANDOM % 9000) + 1000 )); \
	echo "Building image with tag $$FOUR_DIGIT_TAG via Skaffold..."; \
	SKAFFOLD_PLATFORM_ARG=""; \
	if [ -n "$(SKAFFOLD_PLATFORM)" ]; then \
		echo "Forcing Docker build platform: $(SKAFFOLD_PLATFORM)"; \
		SKAFFOLD_PLATFORM_ARG="--platform=$(SKAFFOLD_PLATFORM)"; \
	fi; \
	FOUR_DIGIT_TAG=$$FOUR_DIGIT_TAG skaffold build --kubeconfig=$(K8S_KUBECONFIG) $$SKAFFOLD_PLATFORM_ARG -t "$$FOUR_DIGIT_TAG"; \
	echo "Deploying Helm release $(HELM_RELEASE) with tag $$FOUR_DIGIT_TAG..."; \
	HELM_VALUES_ARG=""; \
	if [ -n "$(HELM_VALUES_FILE)" ]; then \
		HELM_VALUES_ARG="-f $(HELM_VALUES_FILE)"; \
		echo "Using Helm values file: $(HELM_VALUES_FILE)"; \
	fi; \
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART_DIR) --kubeconfig=$(K8S_KUBECONFIG) -n $(HELM_NAMESPACE) \
		--create-namespace \
		$$HELM_VALUES_ARG \
		--set app.image.tag="$$FOUR_DIGIT_TAG"

# Generic/default run (uses current K8S_KUBECONFIG and chart defaults)
skaffold-run: _skaffold-run

# Talos run
skaffold-run-talos: K8S_KUBECONFIG=$(K8S_KUBECONFIG_TALOS)
skaffold-run-talos: HELM_VALUES_FILE=helm/pertisk-kube/values-talos.yaml
skaffold-run-talos: _skaffold-run

# Talos Hetzner run
skaffold-run-talos-hz: K8S_KUBECONFIG=$(K8S_KUBECONFIG_TALOS_HZ)
skaffold-run-talos-hz: HELM_VALUES_FILE=helm/pertisk-kube/values-talos-hz.yaml
skaffold-run-talos-hz: _skaffold-run

# Orion run (default multi-arch for mixed-node clusters)
skaffold-run-orion: K8S_KUBECONFIG=$(K8S_KUBECONFIG_ORION)
skaffold-run-orion: HELM_VALUES_FILE=helm/pertisk-kube/values-orion.yaml
skaffold-run-orion: SKAFFOLD_PLATFORM=linux/amd64,linux/arm64
skaffold-run-orion: _skaffold-run

# Orion multi-arch run (amd64 + arm64)
skaffold-run-orion-multi: skaffold-run-orion

# Orion arm64-only run (single-arch)
skaffold-run-orion-arm64: K8S_KUBECONFIG=$(K8S_KUBECONFIG_ORION)
skaffold-run-orion-arm64: HELM_VALUES_FILE=helm/pertisk-kube/values-orion.yaml
skaffold-run-orion-arm64: SKAFFOLD_PLATFORM=linux/arm64
skaffold-run-orion-arm64: _skaffold-run

# Run once with production profile (git tag versioning + prod values)
skaffold-run-prod:
	@set -e; \
	TMP_BUILD_OUTPUT=$$(mktemp); \
	trap 'rm -f "$$TMP_BUILD_OUTPUT"' EXIT INT TERM; \
	echo "Building image with Skaffold prod profile..."; \
	skaffold build -p prod --kubeconfig=$(K8S_KUBECONFIG) --file-output "$$TMP_BUILD_OUTPUT"; \
	IMAGE_TAG=$$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$$TMP_BUILD_OUTPUT" | head -n 1); \
	if [ -z "$$IMAGE_TAG" ]; then \
		echo "Failed to parse image tag from skaffold file output"; \
		exit 1; \
	fi; \
	echo "Deploying Helm release $(HELM_RELEASE) with prod values and tag $$IMAGE_TAG..."; \
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART_DIR) --kubeconfig=$(K8S_KUBECONFIG) -n $(HELM_NAMESPACE) \
		--create-namespace \
		-f helm/pertisk-kube/values-prod.yaml \
		--set app.image.tag="$$IMAGE_TAG"

# Watch mode: rebuild and redeploy on source changes
skaffold-dev:
	@set -e; \
	HELM_SHORT=$$(helm version --short 2>/dev/null || true); \
	HELM3_BIN=$$(command -v helm3 2>/dev/null || true); \
	if echo "$$HELM_SHORT" | grep -q '^v4\.'; then \
		if [ -z "$$HELM3_BIN" ] && command -v brew >/dev/null 2>&1; then \
			BREW_HELM3=$$(brew --prefix helm@3 2>/dev/null)/bin/helm; \
			if [ -x "$$BREW_HELM3" ]; then HELM3_BIN="$$BREW_HELM3"; fi; \
		fi; \
		if [ -z "$$HELM3_BIN" ]; then \
			echo "Helm v4 detected ($$HELM_SHORT), but Skaffold v2 Helm deploy needs Helm v3."; \
			echo "Install Helm 3 (e.g. 'brew install helm@3') or upgrade Skaffold to a Helm v4-compatible version."; \
			exit 1; \
		fi; \
		TMP_BIN=$$(mktemp -d); \
		trap 'rm -rf "$$TMP_BIN"' EXIT INT TERM; \
		ln -sf "$$HELM3_BIN" "$$TMP_BIN/helm"; \
		for p in $$HOME/Library/helm/plugins/skaffold-render*; do [ -d "$$p" ] && rm -rf "$$p"; done; \
		PATH="$$TMP_BIN:$$PATH" skaffold dev --kubeconfig=$(K8S_KUBECONFIG); \
	else \
		for p in $$HOME/Library/helm/plugins/skaffold-render*; do [ -d "$$p" ] && rm -rf "$$p"; done; \
		skaffold dev --kubeconfig=$(K8S_KUBECONFIG); \
	fi

# Build and push the image only (no deploy)
skaffold-build:
	skaffold build

# Build and push multi-arch image only (no deploy)
skaffold-build-multi:
	skaffold build --platform=linux/amd64,linux/arm64

# Tear down the Helm release deployed by Skaffold
skaffold-delete:
	@set -e; \
	HELM_SHORT=$$(helm version --short 2>/dev/null || true); \
	HELM3_BIN=$$(command -v helm3 2>/dev/null || true); \
	if echo "$$HELM_SHORT" | grep -q '^v4\.'; then \
		if [ -z "$$HELM3_BIN" ] && command -v brew >/dev/null 2>&1; then \
			BREW_HELM3=$$(brew --prefix helm@3 2>/dev/null)/bin/helm; \
			if [ -x "$$BREW_HELM3" ]; then HELM3_BIN="$$BREW_HELM3"; fi; \
		fi; \
		if [ -z "$$HELM3_BIN" ]; then \
			echo "Helm v4 detected ($$HELM_SHORT), but Skaffold v2 Helm deploy needs Helm v3."; \
			echo "Install Helm 3 (e.g. 'brew install helm@3') or upgrade Skaffold to a Helm v4-compatible version."; \
			exit 1; \
		fi; \
		TMP_BIN=$$(mktemp -d); \
		trap 'rm -rf "$$TMP_BIN"' EXIT INT TERM; \
		ln -sf "$$HELM3_BIN" "$$TMP_BIN/helm"; \
		for p in $$HOME/Library/helm/plugins/skaffold-render*; do [ -d "$$p" ] && rm -rf "$$p"; done; \
		PATH="$$TMP_BIN:$$PATH" skaffold delete --kubeconfig=$(K8S_KUBECONFIG); \
	else \
		for p in $$HOME/Library/helm/plugins/skaffold-render*; do [ -d "$$p" ] && rm -rf "$$p"; done; \
		skaffold delete --kubeconfig=$(K8S_KUBECONFIG); \
	fi

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

