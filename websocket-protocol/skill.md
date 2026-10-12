{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### skill

Skills are learned procedures stored as graph nodes with trigger context. See `docs/agent-ir-spec.md` for the skill shape.

#### `skill.ingest`
- **Params**: `{ name: string, code: string, platform?: string, persona?: string, url_pattern?: string, description?: string, task_keywords?: string[], supersedes?: string }`
- **Returns**: numeric memgine node id of the ingested skill

#### `skill.find`
- **Params**: `{ persona?: string, url?: string, task?: string, max_results?: number = 1 }`
- **Returns**: `[ { name, code, platform, description, stats, match_score }, ... ]`
- Spreading-activation match against trigger edges.

#### `skill.report`
- **Params**: `{ skill_name: string, outcome: "success" | string }`
- **Returns**: updated stats. Skills auto-degrade when `fail_count > success_count + 2`.

#### `skill.gate_deployment`
- **Params**: `{ skill_name: string, provenance?: SkillProvenance, requested_tier: "read_only" | "sandbox_edit" | "full_access" }`
- **Returns**: `SkillDeploymentDecision` `{ trust, ceiling, granted, outcome: "allow" | "downgrade" | "deny", reason }`
- Gates a skill's requested deployment capability against its provenance (arXiv 2602.12430 "Agent Skills"; `docs/proposals/skill-trust-governance.md`). The caller supplies the **static** provenance (signature/scan/source — typically built from a `car-bundle` manifest via `assess_signature_trust`); the daemon overrides the **lifecycle** counts (`success_count`/`fail_count`) with the named skill's real track record before gating, so a skill failing in the field is demoted to `untrusted` and denied despite an official signature. Live counterpart to the stateless `gate_skill_deployment` FFI helper. FFI: `gateSkillDeploymentLive` (NAPI) / `gate_skill_deployment_live` (PyO3).

#### `skill.enforce_deployment`
- **Params**: `{ skill_name: string, provenance?: SkillProvenance, requested_tier: "read_only" | "sandbox_edit" | "full_access" }`
- **Returns**: `{ decision: SkillDeploymentDecision, enforcement: { deploy, effective_tier, overridden, blocked, pending, reason }, pending_approval?: { fingerprint, skill_name, requested_tier } }`
- The **load-time enforcement** bridge (Slice 4): gates the skill (as `skill.gate_deployment`), then resolves the verdict against the daemon's **shared durable** `ApprovalLedger` — the same restart-surviving, cross-connection ledger `permission.*` writes to. `Allow`/`Downgrade` deploy autonomously (a downgrade is the gate's own safe mitigation); a `Deny` is **overridden** if an operator previously approved it (deploys at the requested tier), **blocked** if rejected, or surfaced as `pending_approval` for an unseen deny. The host resolves a pending approval via `permission.approve`/`permission.reject` keyed by the returned `fingerprint`. FFI: `enforceSkillDeploymentLive` (NAPI) / `enforce_skill_deployment_live` (PyO3).

#### `skill.ingest_governed`
- **Params**: the same flat skill fields as `skill.ingest` (`name`, `code`, `platform`, `persona?`, `url_pattern?`, `description?`, `supersedes?`, `task_keywords?`), plus `provenance?: SkillProvenance` and `requested_tier: "read_only" | "sandbox_edit" | "full_access"`
- **Returns**: `{ ingested: bool, node?: number, decision: SkillDeploymentDecision, enforcement, pending_approval?: { fingerprint, skill_name, requested_tier } }`
- The **loader integration**: ingests a skill *through* the deployment gate. Gates the provenance against the requested capability, enforces against the daemon's shared durable `ApprovalLedger`, and **only adds the skill to the graph when deployment is permitted** — stamping the granted ceiling onto `SkillMeta.deployment_tier` (which survives `memory.persist` and is visible to execution). A denied skill is not ingested (`ingested: false`); an unseen deny surfaces a `pending_approval` resolved via `permission.approve`/`permission.reject`. FFI: `ingestSkillGoverned` (NAPI) / `ingest_skill_governed` (PyO3).

#### `skill.adopt_pack`
- **Params**: `{ pack: ApprovedSkillPack, requested_tier?: "read_only" | "sandbox_edit" | "full_access" = "read_only", manifest?: AgentManifest, provenance?: SkillProvenance, scanned?: boolean = false, vulnerabilities?: number = 0, source?: "official" | "first_party" | "community" | "unknown" = "unknown" }`
- **Returns**: `{ loaded: string[], pending: [ { skill_id, fingerprint }, ... ], refused: [ { skill_id, reason }, ... ], requested_tier: string, provenance: SkillProvenance, trusted_signers: number }`
- The **daemon call-site** for governed pack adoption: materializes an `ApprovedSkillPack` into the session graph with every skill routed through the deployment gate. Governance is **unconditional** here — there is no ungoverned mode on this method, which is what makes governed adoption the default rather than something a host opts into. Provenance comes from **either** `manifest` **or** a caller-assembled `provenance`; passing **both is an error**, because silently preferring one would drop a security-relevant input, and passing neither yields the conservative unsigned/unscanned default. The two paths are not equivalent: `manifest` is the **derived** path — the caller cannot assert `signed`/`signer_trusted`, which are computed by `MemgineEngine::skill_provenance_from_bundle` against the operator's `.car/config.toml` `trusted_skill_signers` keyring, read **only** from operator config and never from the request (a caller that could name its own trusted keys would be self-certifying). `provenance` is a **trusted-caller escape hatch**: it is taken at face value and nothing clamps or cross-checks it, so any caller that can reach this method can assert any trust tier, up to `official` + `full_access`. It exists for hosts carrying their own attestation — the same contract `skill.ingest_governed` offers — and it means the keyring rule constrains the `manifest` path only. On that path, an empty keyring costs less than it sounds: `signer_trusted` separates **only** `Official` from `Verified`, so a signed + scanned pack lands `Verified` → `sandbox_edit` rather than `Official` → `full_access`; it is never demoted to `Community` (which requires `scanned && !signed`), and an unscanned pack is `Untrusted` → denied either way. Since `scanned` is caller-supplied on every path, a self-signed manifest sent with `"scanned": true` reaches `sandbox_edit` against an empty keyring. Enforcement runs against the daemon's **shared durable** `ApprovalLedger` — the same restart-surviving, cross-connection ledger `permission.*` writes to: a `Deny` skill **never enters the graph**, a previously-approved override deploys, and an unseen deny surfaces in `pending` with a fingerprint the host resolves via `permission.approve`/`permission.reject` before re-adopting. Adoption is **per-skill, so a pack can adopt partially** — the skills whose verdict permits deployment land in `loaded` while the others surface in `pending`/`refused`, and the host re-adopts the same pack after resolving them. `trusted_signers` is a **count**, not the key ids — enough to tell an operator "your keyring is empty, that is why a signed pack stopped at Verified" without echoing configured identifiers over the wire. FFI: `adoptSkillPack` (NAPI) / `adopt_skill_pack` (PyO3).


{% endraw %}
