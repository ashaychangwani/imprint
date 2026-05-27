#!/usr/bin/env bash
set -euo pipefail

# Imprint standalone binary installer.
# Usage: curl -fsSL https://raw.githubusercontent.com/ashaychangwani/imprint/main/scripts/install.sh | bash

REPO="ashaychangwani/imprint"
INSTALL_DIR="${IMPRINT_INSTALL_DIR:-$HOME/.local/bin}"

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    *)
      echo "error: unsupported OS: $os" >&2
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "error: unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
}

main() {
  local platform version url tmp

  platform="$(detect_platform)"
  echo "Detected platform: ${platform}"

  echo "Fetching latest release…"
  version="$(get_latest_version)"
  if [ -z "$version" ]; then
    echo "error: could not determine latest version" >&2
    exit 1
  fi
  echo "Latest version: ${version}"

  url="https://github.com/${REPO}/releases/download/${version}/imprint-${platform}"

  mkdir -p "$INSTALL_DIR"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT

  echo "Downloading imprint-${platform}…"
  curl -fSL --progress-bar -o "$tmp" "$url"
  chmod +x "$tmp"
  mv "$tmp" "${INSTALL_DIR}/imprint"
  trap - EXIT

  echo ""
  echo "Installed imprint ${version} to ${INSTALL_DIR}/imprint"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  echo ""
  echo "Get started:"
  echo "  imprint --help"
  echo ""
  echo "Note: teach, record, and login commands require a full Bun + Playwright install."
  echo "The standalone binary supports mcp-server, install, cron, and credential commands."
}

main
