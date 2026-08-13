#!/usr/bin/env bash
# Build .rpm with fpm. Intended to run inside docker/Dockerfile.package.
set -euo pipefail
cd /work

PKG_NAME="${PKG_NAME:-pertisk-kube}"
VERSION="${VERSION:?VERSION is required}"
rpm_arch="${rpm_arch:-x86_64}"
PKG_DIR="${PKG_DIR:-pkg-pertisk-kube}"

fpm -s dir -t rpm --force \
  -n "$PKG_NAME" \
  -v "$VERSION" \
  -a "$rpm_arch" \
  --description "Pertisk Kubernetes web dashboard" \
  --url "https://github.com/pertisktech/pertisk-kube-web" \
  --maintainer "Pertisk Team" \
  --license "MIT OR Apache-2.0" \
  --vendor "Pertisk" \
  --category "System Environment/Daemons" \
  --depends shadow-utils \
  --before-install /work/preinstall.sh \
  --after-install /work/postinstall.sh \
  --before-remove /work/preremove.sh \
  --config-files /etc/pertisk-kube/pertisk-kube.conf \
  --directories /var/lib/pertisk-kube \
  --directories /var/log/pertisk-kube \
  --directories /usr/share/pertisk-kube \
  --rpm-os linux \
  -p /work/release \
  -C "/work/${PKG_DIR}" .
