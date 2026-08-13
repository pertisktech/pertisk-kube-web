#!/usr/bin/env bash
# Build an amd64 RPM for pertisk-kube (binary + SPA + systemd unit).
# Usage: ./build/package-rpm-amd64.sh [VERSION]
# Requires: docker (buildx for cross-compile + fpm packaging).
# Run from repo root: make build-rpm-amd64

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARCH=amd64
rpm_arch=x86_64
PKG_NAME="${PKG_NAME:-pertisk-kube}"
VERSION="${1:-${VERSION:-$(git describe --tags --always 2>/dev/null | sed 's/^v//' || echo '0.1.0')}}"
VERSION="${VERSION#v}"
# RPM versions cannot contain hyphens
VERSION="$(echo "$VERSION" | tr '-' '.')"

RELEASE_DIR="${RELEASE_DIR:-release}"
BUILDER_NAME="${BUILDER_NAME:-pertisk-kube-package}"
CACHE_DIR="${CACHE_DIR:-.buildx-cache/release}"
ARTIFACT_DIR="${ARTIFACT_DIR:-.build/artifacts-amd64}"
PKG_DIR="pkg-${PKG_NAME}"
CARGO_JOBS="${PERTISK_CARGO_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

mkdir -p "$RELEASE_DIR" "$CACHE_DIR/$ARCH"

echo "==> Building linux/$ARCH artifacts (version $VERSION)..."
export DOCKER_BUILDKIT=1

if ! docker buildx inspect "$BUILDER_NAME" --bootstrap >/dev/null 2>&1; then
  echo "Creating buildx builder '$BUILDER_NAME'..."
  docker buildx rm "$BUILDER_NAME" >/dev/null 2>&1 || true
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap
fi

rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"

cache_from=()
if [ -f "${CACHE_DIR}/${ARCH}/index.json" ]; then
  cache_from=(--cache-from "type=local,src=${CACHE_DIR}/${ARCH}")
fi

docker buildx build --builder "$BUILDER_NAME" --platform "linux/${ARCH}" \
  -f docker/Dockerfile.release \
  --target artifacts \
  ${cache_from[@]+"${cache_from[@]}"} \
  --cache-to "type=local,dest=${CACHE_DIR}/${ARCH},mode=max" \
  --build-arg TARGETPLATFORM="linux/${ARCH}" \
  --build-arg TARGETARCH="$ARCH" \
  --build-arg VERSION="$VERSION" \
  --build-arg CARGO_BUILD_JOBS="$CARGO_JOBS" \
  -o "type=local,dest=${ARTIFACT_DIR}" \
  .

if [ ! -f "${ARTIFACT_DIR}/pertisk-kube" ]; then
  echo "Error: binary not found in ${ARTIFACT_DIR}" >&2
  ls -la "$ARTIFACT_DIR" >&2 || true
  exit 1
fi
if [ ! -f "${ARTIFACT_DIR}/static/index.html" ]; then
  echo "Error: frontend assets not found in ${ARTIFACT_DIR}/static" >&2
  ls -la "${ARTIFACT_DIR}/static" >&2 || true
  exit 1
fi

if command -v file >/dev/null 2>&1; then
  if ! file "${ARTIFACT_DIR}/pertisk-kube" | grep -Eq 'ELF 64-bit.*x86-64'; then
    echo "Error: binary is not linux/amd64:" >&2
    file "${ARTIFACT_DIR}/pertisk-kube" >&2
    exit 1
  fi
fi

echo "==> Assembling package layout..."
rm -rf "$PKG_DIR"
mkdir -p \
  "${PKG_DIR}/usr/bin" \
  "${PKG_DIR}/etc/pertisk-kube" \
  "${PKG_DIR}/usr/share/pertisk-kube/static" \
  "${PKG_DIR}/var/lib/pertisk-kube" \
  "${PKG_DIR}/var/log/pertisk-kube" \
  "${PKG_DIR}/lib/systemd/system"

cp "${ARTIFACT_DIR}/pertisk-kube" "${PKG_DIR}/usr/bin/pertisk-kube"
chmod +x "${PKG_DIR}/usr/bin/pertisk-kube"
cp -R "${ARTIFACT_DIR}/static/." "${PKG_DIR}/usr/share/pertisk-kube/static/"
cp build/pertisk-kube.conf "${PKG_DIR}/etc/pertisk-kube/pertisk-kube.conf"
cp build/pertisk-kube.service "${PKG_DIR}/lib/systemd/system/pertisk-kube.service"

cat > preinstall.sh << 'PRE'
#!/bin/sh
set -e
if ! getent group pertisk-kube >/dev/null 2>&1; then
  groupadd --system pertisk-kube
fi
if ! getent passwd pertisk-kube >/dev/null 2>&1; then
  useradd --system --gid pertisk-kube --home-dir /var/lib/pertisk-kube \
    --shell /usr/sbin/nologin --comment "pertisk-kube" pertisk-kube
fi
PRE

cat > postinstall.sh << 'POST'
#!/bin/sh
set -e
mkdir -p /var/lib/pertisk-kube /var/log/pertisk-kube /etc/pertisk-kube
chown -R pertisk-kube:pertisk-kube /var/lib/pertisk-kube /var/log/pertisk-kube
chmod 750 /var/lib/pertisk-kube /var/log/pertisk-kube
if [ -d /etc/pertisk-kube ]; then
  chown -R root:pertisk-kube /etc/pertisk-kube
  chmod 750 /etc/pertisk-kube
  chmod 640 /etc/pertisk-kube/*.conf 2>/dev/null || true
  if [ -f /etc/pertisk-kube/kubeconfig ]; then
    chown root:pertisk-kube /etc/pertisk-kube/kubeconfig
    chmod 640 /etc/pertisk-kube/kubeconfig
  else
    echo "NOTE: pertisk-kube starts without a kubeconfig; connect a cluster from the UI after login." >&2
  fi
fi
command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
POST

cat > preremove.sh << 'PRE'
#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop pertisk-kube 2>/dev/null || true
  systemctl disable pertisk-kube 2>/dev/null || true
fi
PRE

chmod +x preinstall.sh postinstall.sh preremove.sh build/rpm.sh

if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$PKG_DIR" 2>/dev/null || true
fi
[ "$(uname -s)" = "Darwin" ] && export COPYFILE_DISABLE=1

echo "==> Building RPM via fpm container..."
docker build -q -f docker/Dockerfile.package -t pertisk-kube-package .
docker run --rm \
  -v "$(pwd):/work" -w /work \
  -e PKG_NAME="$PKG_NAME" \
  -e VERSION="$VERSION" \
  -e rpm_arch="$rpm_arch" \
  -e PKG_DIR="$PKG_DIR" \
  pertisk-kube-package bash /work/build/rpm.sh

# Also keep a tarball next to the RPM for convenience.
tar -czvf "${RELEASE_DIR}/${PKG_NAME}-v${VERSION}-linux-${ARCH}.tar.gz" \
  -C "$PKG_DIR" usr etc var lib

rm -f preinstall.sh postinstall.sh preremove.sh

echo
echo "Done. Artifacts in ${RELEASE_DIR}/:"
ls -lh "${RELEASE_DIR}"/*"${VERSION}"* "${RELEASE_DIR}"/*"${ARCH}"* 2>/dev/null || ls -lh "${RELEASE_DIR}/"
