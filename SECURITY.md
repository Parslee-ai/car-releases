# Security

CAR ships as signed binaries you install and grant real OS permissions to. This
document covers how those binaries are signed, how to verify what you download,
what the trust boundary is, and how to report a vulnerability.

## Reporting a vulnerability

**Report privately — do not open a public issue for a security problem.**

Use GitHub's private advisory flow on this repository:
**[Security → Report a vulnerability](https://github.com/Parslee-ai/car-releases/security/advisories/new)**.

That opens a private channel with the maintainers. Please include the version,
platform, and a reproduction. We'll acknowledge, triage, and coordinate a fix and
disclosure timeline with you. Public issues and PRs are for install/crash/platform
bug reports (see the README's *Issues* section), not security disclosures.

## How the binaries are signed

| Artifact | Signing |
|----------|---------|
| **macOS app + CLI** (`CAR-darwin-arm64.pkg`, `car`, `car-server`, `CAR Host.app`) | Apple **Developer ID**, **notarized** by Apple, stapled. Gatekeeper verifies on first launch. |
| **`CarFfi.xcframework`** (Swift/Apple) | Developer ID signed + notarized. |
| **In-app updates** (macOS) | Delivered via **Sparkle** over an **EdDSA-signed appcast** (`appcast.xml`). The app ships the public key and rejects any update whose signature doesn't verify. |
| **Windows** (`car-server.exe`, `car.exe`, `car-tray.exe`) | Authenticode signing via **Azure Trusted Signing** (rolling out; until it lands, expect a SmartScreen prompt on first run). |
| **Linux** | No OS-level code-signing standard; verify via provenance + (roadmap) published checksums. |

### Verifying a macOS download

macOS notarization is the strongest guarantee here — Gatekeeper checks it
automatically. To verify by hand before running:

```bash
# The .pkg / .app is notarized and its signature is intact:
spctl --assess --type install --verbose CAR-darwin-arm64.pkg
codesign --verify --deep --strict --verbose=2 /Applications/CAR\ Host.app
```

A pass means the bytes are Apple-notarized and unmodified since signing.

### Verifying a Linux / Windows download

There is currently **no published `SHA256SUMS` file** for the tarballs/zips, and
Linux has no OS signature to check. Until checksums ship (see *Roadmap* below),
the provenance guarantee is: every release asset is built and published by the
CI pipeline in the private source repo and mirrored here on a `v*` tag — there is
no manual asset upload path. Prefer the notarized macOS `.pkg`, `pip`, or `npm`
when you want a verified install today.

## About `curl … | sh`

The convenience installer is `curl -fsSL …/install.sh | sh`. Piping a script
straight into a shell is reasonable to be cautious about. If you'd rather inspect
before running — which we recommend for any such installer:

```bash
# Download, read it, then run it.
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh -o car-install.sh
less car-install.sh          # it downloads the platform tarball into ~/.car/bin and prints a PATH line
sh car-install.sh
```

`install.sh` fetches only official `car-releases` GitHub release assets and
installs into `~/.car/bin` (override with `CAR_INSTALL=…`); it does not need root.
On macOS, the notarized `.pkg` or `brew` are the higher-assurance paths.

## Trust boundary — why the runtime is a sealed binary

Two reasons, both load-bearing.

**1. The runtime is the agent's guardrail.** CAR validates and verifies what
models propose before any side-effecting action runs. If an agent operating in
your environment could rewrite the validator, the validator would stop being a
check on the model and become a suggestion the agent can edit out. Distributing
the runtime as a sealed binary means agents can *call into* CAR but cannot patch
their own guardrails — verification stays a property of the substrate, not
something the model can disable.

**2. A stable signed identity unlocks privileged OS surfaces.** On macOS the
capabilities users actually want from an agent — microphone / screen-capture /
accessibility access, App Intents registration, Apple Translation XPC,
Keychain-stored secrets, notarized framework calls — are bound to a code-signed
identity. A user-rebuildable runtime resets TCC permissions on every build and
can't carry the entitlements the OS gates behind notarized signatures. One signed
binary lets you grant permission once to "Common Agent Runtime" and have it
persist across upgrades.

Agents run under CAR's own safety controls: policies enforced in Rust before any
tool fires, permission tiers with human-in-the-loop approval for high-risk
actions, and per-agent permissions (always-allow / require-approval / deny). See
[SPEC.md](./SPEC.md) for the policy and verification semantics.

Source access for vendors, integrators, and research collaborations is available
under separate terms — see the README's *License* section.

## What CAR stores locally

- `~/.car/` — config, task/agent definitions, memory-graph snapshots, the
  approval ledger, and (opt-in) enrolled voiceprints. All on your machine.
- Secrets go through the OS keystore where available (macOS Keychain) rather
  than plaintext files.
- No telemetry is sent to Parslee by the runtime.

## Roadmap

Trust-signal hardening we intend to add (tracked on this repo's issues):

- **Published `SHA256SUMS`** for every release asset, so Linux/Windows tarballs
  are verifiable without OS signing.
- **Build provenance attestations** (SLSA / GitHub artifact attestations) tying
  each asset to the CI run that built it.
- **SBOM** for the shipped binaries.
