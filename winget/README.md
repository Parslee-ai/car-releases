# Winget manifests

Authoritative source for the `Parslee.Car` package manifests. Winget discovers
packages by reading `microsoft/winget-pkgs`, so these manifests need to be
copied into that repo via a pull request for each release.

## Submit a new version

1. Bump the three files in `manifests/p/Parslee/Car/<version>/`:
   - `Parslee.Car.yaml`
   - `Parslee.Car.installer.yaml` (update `InstallerUrl`, `InstallerSha256`, `ReleaseDate`)
   - `Parslee.Car.locale.en-US.yaml` (update `PackageVersion`, `ReleaseNotesUrl`)
2. Validate locally:
   ```powershell
   winget validate --manifest manifests/p/Parslee/Car/<version>
   ```
3. Fork `microsoft/winget-pkgs`, copy this `manifests/` subtree under the
   same path, commit, open a PR.

The first PR (the initial `Parslee.Car` submission) bootstraps the package;
subsequent releases only add a new version directory.
