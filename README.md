# ALOOKHOR Release Control

This public repository is the release-control plane for read-only verification of build artifacts produced by the private `hhossineyhossiney/alookhor-store` repository.

## Safety boundary

- The application source repository remains private.
- Do not store application source, signing private keys, deployment credentials, database configuration, or production data here.
- The initial workflow scope is read-only preflight. It must not sign artifacts, connect to a server, deploy, change DNS, or run database migrations.
- Never set readiness variables merely to make a workflow pass. Production signing and deployment require separate review, pinned key verification, secure server access, verified backup, and rollback controls.

## Initial setup

1. Keep this repository public and keep `alookhor-store` private.
2. In this repository, add a fine-grained token as an Actions repository secret named `ALOOKHOR_SOURCE_READ_TOKEN`. The token should grant read-only **Actions** and **Contents** access to `hhossineyhossiney/alookhor-store` only. Do not paste the token into chat.
3. Use a manually dispatched read-only preflight workflow to verify a successful source build run, its exact 40-character commit SHA, and the expected release artifact.
4. Review the run logs. A green preflight is not production-release approval and does not mean deployment is ready.

## Not yet implemented

Signing, production environment approvals, VPS dispatcher, server-side SHA verification, backup verification, activation, health checks, and rollback are separate gates. Do not assume any of them are complete.
