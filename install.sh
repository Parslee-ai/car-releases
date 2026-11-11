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

# --- Linux: C library ---------------------------------------------------------
#
# The Linux binaries are built on Ubuntu 24.04 (the `runs-on` of build-linux in
# the car repo's build.yml) and link against its glibc, so they do not start on
# an older glibc or on musl. Stop here rather than install binaries that fail
# with "GLIBC_2.xx not found". Raise MIN_GLIBC when that runner moves.

MIN_GLIBC="2.39"
REQUIREMENTS_URL="https://github.com/${REPO}/blob/main/DISTRIBUTION.md#linux-requirements"

# Prints the running glibc version (for example 2.39), or nothing when it
# cannot be read.
glibc_version() {
    v=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}') || v=""
    if [ -z "$v" ]; then
        v=$(ldd --version 2>&1 | awk 'NR==1 {print $NF}') || v=""
    fi
    case "$v" in
        [0-9]*.[0-9]*) printf '%s\n' "$v" ;;
    esac
}

# True when version $1 is at least version $2 (both major.minor).
version_at_least() {
    have_major=${1%%.*}; have_rest=${1#*.}; have_minor=${have_rest%%.*}
    need_major=${2%%.*}; need_minor=${2#*.}
    case "$have_major$have_minor" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$have_major" -gt "$need_major" ] ||
        { [ "$have_major" -eq "$need_major" ] && [ "$have_minor" -ge "$need_minor" ]; }
}

if [ "$os" = "linux" ]; then
    if ldd --version 2>&1 | grep -qi musl; then
        die "this system uses musl libc. CAR's Linux binaries need glibc ${MIN_GLIBC} or newer. See ${REQUIREMENTS_URL}"
    fi
    glibc=$(glibc_version)
    if [ -z "$glibc" ]; then
        warn "couldn't read the glibc version; CAR's Linux binaries need glibc ${MIN_GLIBC} or newer"
    elif ! version_at_least "$glibc" "$MIN_GLIBC"; then
        die "this system has glibc ${glibc}. CAR's Linux binaries need glibc ${MIN_GLIBC} or newer (Ubuntu 24.04+, Debian 13+, Fedora 40+). See ${REQUIREMENTS_URL}"
    fi
fi

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

for bin in car car-server car-memgine-eval car-mcp; do
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

# `car` and `car-server` load the ALSA and D-Bus client libraries at start.
# Minimal images and servers often have neither. Only checked when the
# loader cache can be read.
if [ "$os" = "linux" ]; then
    ldconfig_bin=$(command -v ldconfig 2>/dev/null || echo /sbin/ldconfig)
    if libs=$("$ldconfig_bin" -p 2>/dev/null) && [ -n "$libs" ]; then
        missing=""
        for lib in libasound.so.2 libdbus-1.so.3; do
            printf '%s\n' "$libs" | grep -q "$lib" || missing="$missing $lib"
        done
        if [ -n "$missing" ]; then
            warn "missing runtime libraries:${missing}. car won't start until they are installed:"
            warn "  Debian 13 / Ubuntu 24.04+: sudo apt install libasound2t64 libdbus-1-3"
            warn "  Fedora: sudo dnf install alsa-lib dbus-libs"
        fi
    fi
fi

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
