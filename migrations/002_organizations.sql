CREATE TYPE organization_type_enum AS ENUM (
    'HOME_CARE_AGENCY',
    'RESIDENTIAL_CARE_HOME',
    'INDEPENDENT_PROVIDER'
);

CREATE TYPE organization_status_enum AS ENUM (
    'trial',
    'active',
    'suspended'
);

CREATE TABLE organizations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    organization_type organization_type_enum NOT NULL,
    status          organization_status_enum NOT NULL DEFAULT 'trial',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz NULL
);

CREATE TABLE organization_settings (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id             uuid NOT NULL UNIQUE
                                    REFERENCES organizations(id),
    override_requires_supervisor boolean NOT NULL DEFAULT true,
    settings_json               jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    name            text NOT NULL,
    address         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz NULL,
    UNIQUE (id, organization_id)
);

CREATE TABLE units (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     uuid NOT NULL,
    organization_id uuid NOT NULL,
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz NULL,
    FOREIGN KEY (location_id, organization_id)
        REFERENCES locations (id, organization_id),
    UNIQUE (id, organization_id)
);

CREATE TABLE rooms (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id         uuid NOT NULL,
    organization_id uuid NOT NULL,
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz NULL,
    FOREIGN KEY (unit_id, organization_id)
        REFERENCES units (id, organization_id),
    UNIQUE (id, organization_id)
);
