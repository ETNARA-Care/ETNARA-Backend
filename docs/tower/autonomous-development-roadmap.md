# ETNARA Tower — Unattended development architecture

## Goal
Support scheduled, cloud-hosted development workflows that progress without the owner keeping a computer on. This document is a proposal, not an active autonomous execution service.

## Components
- **GitHub Actions:** scheduled or manually dispatched bounded workflows for repository checks, tests and reporting.
- **Task queue:** allowlisted development tasks with owner, repository, branch, scope, risk tier, due time and audit trail.
- **LEO:** software change proposal and unit-test recommendations.
- **ORION:** architecture and dependency review.
- **AXEL:** operational health and release-readiness review.
- **Human approval:** required for merges, deployments, permission changes, database migrations and security-sensitive modifications.

## Data boundary
Never send tenant patient/resident records, employee/caregiver files, private documents, database dumps, credentials, tokens or raw application logs to agents. Only allowlisted repository metadata, sanitized CI statuses and approved code paths. The separate privacy-remediation effort owns all database access-policy changes.

## First safe milestone
1. Read-only scheduled workflow checks CI and deployment metadata for allowlisted ETNARA repositories.
2. Produce a short audit report of new failures and suggested tasks without collecting private tenant data.
3. Add idempotent run tracking, bounded retries, per-run cost/time caps and alert-on-failure.
4. Test in a non-production environment; verify least-privilege tokens and no secrets in artifacts.
5. Enable scheduled operation only after review.

## Later milestones
- Create draft branches and draft PRs for pre-approved low-risk code maintenance only.
- Run lint, typecheck, unit and integration tests in isolated runners.
- Require review and green checks before merge; deployments must use existing protected workflows.
- Maintain pause switch, audit logs, concurrency limits and rollback documentation.

## Explicit non-goals
No unattended privileged DB queries, tenant data access, credential rotation, production writes, RLS changes, direct merges, or autonomous production deployments. Do not claim this system is running until a workflow is actually configured, enabled and verified.
