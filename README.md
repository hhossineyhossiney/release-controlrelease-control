# ALOOKHOR Release Control

This public repository is the release-control plane for verified artifacts built by the private `hhossineyhossiney/alookhor-store` repository. Keep application source private.

## Workflows

- **Source artifact preflight** (`.github/workflows/source-artifact-preflight.yml`): read-only check of a successful private `main` push build, exact commit SHA, and expected artifact metadata.
- **Production signing** (`.github/workflows/sign-production-release.yml`): cross-repository workflow that re-verifies the exact source run, downloads and validates the artifact, checks an independently pinned public-key fingerprint, signs a production manifest, verifies the resulting bundle, and uploads it as an Actions artifact. It does not connect to the VPS or deploy.
- **VPS dispatcher / activation / rollback**: not implemented in this repository. Do not treat a signed bundle as permission to deploy.

## Required private-source access

In this repository, `Settings → Secrets and variables → Actions → Secrets`, configure:

- `ALOOKHOR_SOURCE_READ_TOKEN`: fine-grained token with **Actions: Read-only** and **Contents: Read-only** on only `hhossineyhossiney/alookhor-store`. Never paste it into chat or commit it.

## Production-signing gate — leave disabled until every check is complete

In this repository, create an Environment named exactly `production-signing`:

1. Require at least one independent User or Team reviewer and enable prevention of self-review.
2. Restrict deployment branches using a custom policy containing exactly `main`.
3. Under that Environment's **secrets**, set `PRODUCTION_RELEASE_SIGNING_PRIVATE_KEY` to the private PEM key held securely by the owner.
4. Under that Environment's **variables**, set `PRODUCTION_RELEASE_PUBLIC_KEY_SHA256` to the independently calculated SHA-256 fingerprint of the corresponding public key's DER encoding (64 lowercase hex characters).
5. Verify the private key matches the fingerprint independently, and verify the environment protection rule and branch policy in GitHub settings.

The workflow also requires Environment variable `VPS_PRODUCTION_SIGNING_READY=true`. **Do not set this variable until all steps above are independently verified.** It is intentionally not set by this repository's workflow or automation. A failed gate is expected until the owner completes these controls. Never set readiness simply to make a run green.

Do not put the private key in repository files, workflow YAML, repository variables, artifacts, logs, or chat. If the signing key has not yet been generated and its public fingerprint independently verified, stop before configuring the readiness variable.

## Running the workflows

For preflight, enter a successful source build run ID, its full commit SHA, and the same SHA as confirmation. The current verified candidate is documented in the conversation; re-check the private repository's Actions page before using a candidate later because build artifacts expire.

For production signing, use the same exact source run ID and SHA only after the Environment and key controls above are verified. A green signing run only proves a signed bundle was produced and verified; it does **not** authorize or perform deployment.

## Safety boundary

- No workflow here changes DNS, connects to a server, deploys, activates a release, runs database migrations, or changes production data.
- No workflow should disable protection rules, bypass review, or set readiness variables to bypass a gate.
- Production deployment remains blocked until a separate reviewed dispatcher, secure server access, server-side SHA verification, a verified backup, and a tested rollback process exist.
