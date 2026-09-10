{% raw %}
# Distribution

Every way to get CAR, the platforms it supports, and the release-asset naming
contract you can build tooling against.

## Platforms

| Platform | Binaries | Python wheel |
|----------|----------|--------------|
| macOS ARM64 (15+) | `car-darwin-arm64.tar.gz` | `macosx_15_0_arm64` |
| Linux x86_64 | `car-linux-x64-gnu.tar.gz` | `manylinux_2_28_x86_64` |
| Linux aarch64 | `car-linux-arm64-gnu.tar.gz` | (no wheel — use the tarball) |
| Windows x86_64 | `car-win32-x64-msvc.zip` | `win_amd64` |

Intel Macs (`x86_64-apple-darwin`) are **not** supported — macOS is Apple Silicon
only. Windows aarch64 is pending. Linux aarch64 ships a CLI / server / `.node`
tarball but no Python wheel.

## Packages

### macOS app + CLI — `.pkg` (no terminal)

Download **`CAR-darwin-arm64.pkg`** from the
[latest release](https://github.com/Parslee-ai/car-releases/releases/latest) and
double-click. Installs **CAR Host.app** → `/Applications` (the menu-bar app:
agents, chat, approvals, diagnostics — it embeds and supervises `car-server`) and
the **`car` CLI** → `/usr/local/bin`. Self-updates via Sparkle. Signed + notarized.

There is no Homebrew cask. The Homebrew path was **removed** in May 2026
(`bec680d90`): the `.pkg` installs CAR Host and updates it in place via
Sparkle, and the cask carried a `car-server install` step that wrote a launchd
LaunchAgent — the flow the `.pkg` exists to replace. The `.pkg` above is the
macOS install.

### Windows app + CLI — `.exe` installer (no terminal)

Download **`CAR-setup-x64.exe`** from the
[latest release](https://github.com/Parslee-ai/car-releases/releases/latest) and
double-click. This is the Windows counterpart to the macOS `.pkg`. Installs
**CarHost** (`car-tray.exe` — the system-tray host: daemon supervision, a native
dashboard and setup wizard) together with the **`car` CLI**, `car-server`,
`car-mcp`, and `car-memgine-eval` into `C:\Program Files\CAR`, adds that
directory to the system PATH, creates a Start Menu shortcut (desktop shortcut
optional), and registers an uninstaller that also clears the run-at-login entry.
Requires admin rights.

Not yet Authenticode-signed, so SmartScreen warns on first run — **More info →
Run anyway**. Tracked in car#248. There is no Sparkle equivalent: update by
downloading and running the newer installer. `car update` refreshes the CLI and
daemon only, and needs an elevated terminal because `C:\Program Files` is not
user-writable.

### Python — PyPI

```bash
pip install car-runtime
```

PyPI auto-resolves the right wheel. Python 3.9+, abi3. Import name is
`car_runtime`. Direct wheel download (if PyPI is unavailable): pick the matching
`car_runtime-<ver>-cp39-abi3-<platform>.whl` from the latest release. Linux
aarch64 has no wheel — use the tarball.

### Node.js — npm

```bash
npm install car-runtime
```

The post-install hook downloads the platform `.node` module from the latest
GitHub release. Air-gapped: set `CAR_RUNTIME_SKIP_DOWNLOAD=1` and drop the `.node`
file in by hand, or load it directly:

```bash
curl -OL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-runtime.darwin-arm64.node
```

```javascript
const native = require('./car-runtime.darwin-arm64.node');
const rt = new native.CarRuntime();
```

### Swift / Apple — `CarFfi.xcframework`

Signed, notarized xcframework (macOS arm64 + iOS device + iOS simulator):

```bash
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/CarFfi.xcframework.zip -o CarFfi.xcframework.zip
ditto -x -k CarFfi.xcframework.zip .
```

Add the unzipped `CarFfi.xcframework` to your target (Xcode → Frameworks, or a
Swift Package `.binaryTarget(path:)`). The generated Swift glue is bundled inside.
Kotlin/Android `.aar` parity is tracked separately.

### CLI + server

The CLI (`car`), server (`car-server`), eval bridge (`car-memgine-eval`), and
stdio MCP server (`car-mcp`) ship
as native binaries.

- **Homebrew**: **not supported.** Removed in May 2026 (`bec680d90`) when the
  signed `.pkg` + Sparkle became the macOS path; the tap
  `Parslee-ai/homebrew-car` is gone. Use the install script or a tarball below.
- **Scoop** (Windows): `scoop bucket add car https://github.com/Parslee-ai/scoop-car && scoop install car`
  Per-user, no admin. CLI binaries only — it does **not** install the CarHost
  tray app; use `CAR-setup-x64.exe` above for that.
- **Winget** (Windows): submission in progress; manifests live under `winget/`.
  Will be `winget install Parslee.Car` once the `microsoft/winget-pkgs` PR lands.
- **Install script** (macOS + Linux — the recommended CLI install today):
  `curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh`
  — installs to `~/.car/bin`, prints the PATH line. Pin with `CAR_VERSION=…`,
  redirect with `CAR_INSTALL=…`. (See [SECURITY.md](./SECURITY.md) for the
  inspect-then-run alternative.)

### Manual tarball / zip

```bash
# Apple Silicon
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
# Linux x86_64
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-linux-x64-gnu.tar.gz | tar -xz
# Windows x86_64 (PowerShell)
Invoke-WebRequest -Uri https://github.com/Parslee-ai/car-releases/releases/latest/download/car-win32-x64-msvc.zip -OutFile car.zip
Expand-Archive car.zip -DestinationPath .
```

Each tarball / zip also contains the Node.js native module
(`car-runtime.<platform>.node`) for users who prefer not to use npm.

## Release-asset naming contract

Stable, version-independent — `…/releases/latest/download/<name>` always resolves
to the newest:

| Asset | Contents |
|-------|----------|
| `car-<platform>.tar.gz` / `.zip` | `car`, `car-server`, `car-memgine-eval`, `car-mcp`, the `.node` module |
| `car-runtime.<platform>.node` | Node native addon, standalone |
| `car_runtime-<ver>-cp39-abi3-<platform>.whl` | Python wheel (carries the version — no `latest` URL) |
| `CAR-darwin-arm64.pkg` | macOS app + CLI installer (signed/notarized) |
| `CAR-setup-x64.exe` | Windows tray app + CLI installer (not yet signed) |
| `CarFfi.xcframework.zip` | Swift/Apple binding (signed/notarized) |
| `appcast.xml` | Sparkle update feed (EdDSA-signed) |

`<platform>` ∈ `darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`,
`win32-x64-msvc`.

## Release mechanism

Releases here are **auto-mirrored** from the private `Parslee-ai/car` source repo
via its CI (`build.yml`, job `mirror-to-car-releases`) on every `v*` tag push —
there is no manual asset-upload path. The manual `mirror-release.yml` workflow in
this repo is a fallback for backfilling older tags. User-facing docs (this file,
the README, `SECURITY.md`, `SPEC.md`, `GUIDE.md`, `BENCHMARKS.md`, `install.sh`,
examples, winget manifests) are generated from `release-mirror/` in the source
repo during the release, so they can't drift.

{% endraw %}
