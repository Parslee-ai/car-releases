#!/bin/sh
# Common Agent Runtime installer.
#
# Downloads the CLI + server binaries for the host platform into ~/.car/bin/
# and prints the PATH tweak to run next. Idempotent.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh
#
# Environment:
#   CAR_VERSION  pin to a specific tag (default: latest)
#   CAR_INSTALL  override install dir (default: ~/.car)
#   CAR_NO_PATH  set to 1 to skip the PATH-setup reminder

set -eu

CAR_VERSION="${CAR_VERSION:-latest}"
CAR_INSTALL="${CAR_INSTALL:-$HOME/.car}"
REPO="Parslee-ai/car-releases"

log()  { printf '\033[1;34m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Platform detection -----------------------------------------------------

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    *)      die "unsupported OS: $uname_s. Supported: Darwin, Linux." ;;
esac

case "$uname_m" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64"   ;;
    *)             die "unsupported CPU: $uname_m. Supported: arm64, x86_64." ;;
esac

case "$os" in
    darwin) target="darwin-${arch}"    ; lib_ext=".node" ;;
    linux)  target="linux-${arch}-gnu" ; lib_ext=".node" ;;
esac

asset="car-${target}.tar.gz"

# --- Resolve version --------------------------------------------------------

if [ "$CAR_VERSION" = "latest" ]; then
    url="https://github.com/${REPO}/releases/latest/download/${asset}"
    tag_url="https://api.github.com/repos/${REPO}/releases/latest"
    resolved_tag=$(curl -fsSL "$tag_url" 2>/dev/null | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || echo "")
    [ -n "$resolved_tag" ] || warn "couldn't read latest tag from GitHub API; continuing with /latest/download URL"
    printed_version="${resolved_tag:-latest}"
else
    url="https://github.com/${REPO}/releases/download/${CAR_VERSION}/${asset}"
    printed_version="$CAR_VERSION"
fi

# --- Download + extract -----------------------------------------------------

log "installing CAR ${printed_version} for ${target}"
log "destination: ${CAR_INSTALL}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log "downloading ${url}"
if ! curl -fSL --progress-bar -o "$tmp/${asset}" "$url"; then
    die "download failed. Check https://github.com/${REPO}/releases for available versions."
fi

log "extracting"
mkdir -p "$CAR_INSTALL/bin"
tar -xzf "$tmp/${asset}" -C "$tmp"

for bin in car car-server car-memgine-eval; do
    if [ -f "$tmp/$bin" ]; then
        install -m 0755 "$tmp/$bin" "$CAR_INSTALL/bin/$bin"
    else
        warn "$bin not present in archive — skipping"
    fi
done

# The .node module is installed alongside for Node.js users who prefer the
# tarball route over `npm install`. Safe to ignore if you use npm.
for f in "$tmp"/car-runtime.*"$lib_ext"; do
    [ -f "$f" ] || continue
    cp "$f" "$CAR_INSTALL/"
done

# --- Done -------------------------------------------------------------------

log "installed binaries:"
ls -1 "$CAR_INSTALL/bin"

if [ "${CAR_NO_PATH:-0}" = "1" ]; then
    exit 0
fi

case ":$PATH:" in
    *":$CAR_INSTALL/bin:"*)
        log "✓ ${CAR_INSTALL}/bin is already on your PATH"
        ;;
    *)
        printf '\n'
        log "add ${CAR_INSTALL}/bin to your PATH:"
        case "${SHELL:-}" in
            */fish) printf '  fish_add_path %s/bin\n' "$CAR_INSTALL" ;;
            *zsh|*bash|*)
                printf '  echo '\''export PATH="%s/bin:$PATH"'\'' >> ~/.%src\n' "$CAR_INSTALL" "${SHELL##*/}"
                ;;
        esac
        ;;
esac

log "try: car --help"
