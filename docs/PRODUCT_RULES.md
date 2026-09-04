# ETNARA Product Rules

## Core Model

ETNARA Care connects:

- Care Recipients / Residents
- Caregivers / Workers
- Family Members
- Agency / Organization Administrators

All access must be scoped by organization and care recipient.

## Caregiver / Worker

A worker may access only care recipients they are authorized or assigned to.

Workers may perform authorized actions such as:

- care events
- shift check-in / check-out
- observations
- incident reporting
- messaging
- permitted care documentation

Workers must not receive organization-wide administrative access unless separately authorized.

## Family

Family access depends on an active authorized relationship with the care recipient.

Family may see family-safe information such as:

- care timeline
- permitted care events
- family-safe shift status
- approved observations
- approved incident information
- authorized messages
- relevant notifications

Family must not automatically see:

- internal administrative notes
- raw operational fields
- internal-only clinical or compliance notes
- unrestricted worker information
- organization-wide information
- raw incident / observation payloads

When necessary, create curated Family-safe responses instead of exposing existing raw endpoints.

## Administration

Authorized agency / organization administrators may access operational information for their own organization, including:

- care recipients
- workers
- assignments
- shifts
- care events
- incidents
- observations
- messaging
- notifications

Admin access must remain organization-scoped.

## Messaging

For a care-recipient conversation:

- authorized participants should be resolved automatically
- Family should not need to open a thread first to receive it
- Workers should not need to open a thread first to receive it
- Admin visibility should follow organization permissions
- participant creation must be idempotent
- duplicate threads should not be created for the same intended conversation

## Timeline / Care Events

An authorized caregiver action tied to a resident should propagate to authorized downstream users.

Example:

Maria creates a care event for Carmen
→ backend stores event for Carmen
→ Family sees family-safe version
→ Admin sees organization-authorized version

## Shifts

Caregiver:
- may check in/out when authorized

Administration:
- may see operational shift details

Family:
- may see only the family-safe status/summary intended for the product

## Observations and Incidents

Caregiver:
- may create when authorized

Administration:
- may access operationally permitted information

Family:
- may access only curated family-safe information
- raw/internal endpoints must remain blocked

## Notifications

Relevant actions should notify authorized users when appropriate.

Potential triggers include:

- messages
- important care events
- incidents
- meaningful shift/status updates

Notifications must always respect organization and care-recipient authorization.

## Data Integrity

- Never duplicate relationships unnecessarily.
- Never create duplicate messaging participants.
- Never create duplicate demo entities.
- Prefer idempotent operations.
- Never delete valid production/staging data to resolve a code problem.

## Security Principle

Correct behavior is:

authorized user → authorized care recipient → authorized data

Never:

user → broad organization data merely because the UI needs something to display.
