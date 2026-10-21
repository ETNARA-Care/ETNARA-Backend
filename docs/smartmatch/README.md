# ETNARA SmartMatch - Phase 1

This document defines a proposed feature. It does not enable matching in production.

## Modes
- Internal: only caregivers affiliated with the publishing agency.
- Network: eligible, opted-in caregivers from other organizations.
- Agency always approves the application before an assignment.

## Caregiver location
- Caregiver explicitly chooses a reference location and can edit or delete it.
- No continuous location tracking.
- Use estimated driving time, initially at most 25 minutes.
- Do not reveal exact patient/service addresses in opportunity listings.

## Security gates
- Server-side authorization and organization isolation on every operation.
- Discovery uses a sanitized opportunity summary, never patient records.
- ETNARA platform administrators cannot browse agency patient records.
- Credential eligibility and scheduling conflicts must be checked again at approval.
- Assignment must be transactional to prevent duplicate approvals.
- Audit events must exclude patient identifiers and precise coordinates.
- Network mode requires explicit agency enablement and privacy review.

## Delivery order
1. Inspect existing assignments, coverage, availability, credential and notification modules.
2. Add database migration and access-controlled services with isolation tests.
3. Add agency publication and caregiver application endpoints.
4. Add routing and opt-in notifications.
5. Connect approvals to existing assignment workflows.
6. Complete security review and pilot with internal mode first.
