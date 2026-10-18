-- PostgreSQL 17+; execute through the transactional migration runner.
-- Migration operator owns objects. Application connections must SET ROLE to
-- powershift_app and set a verified, transaction-local powershift.owner_id.
CREATE ROLE powershift_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA powershift;
REVOKE ALL ON SCHEMA powershift FROM PUBLIC;
-- Each migration must explicitly revoke PUBLIC function execution: a schema-
-- scoped default-privilege REVOKE cannot override the global PUBLIC default.

CREATE FUNCTION powershift.current_owner_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT nullif(current_setting('powershift.owner_id', true), '')::uuid
$$;

CREATE FUNCTION powershift.finite_numeric(value numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
    SELECT value NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
$$;

CREATE FUNCTION powershift.valid_text(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
    SELECT char_length(value) BETWEEN 1 AND 200
       AND value !~ '^\s' AND value !~ '\s$'
$$;

CREATE FUNCTION powershift.valid_provenance(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE field text; item jsonb; origin text;
BEGIN
    IF jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
    IF (value ?& ARRAY['name','quantity','rated_watts','hours_per_day',
            'effective_load_percent','brand','model']) IS NOT TRUE
        OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 7 THEN RETURN false; END IF;
    FOR field, item IN SELECT * FROM jsonb_each(value) LOOP
        IF jsonb_typeof(item) <> 'object'
            OR (item ?& ARRAY['origin','evidence']) IS NOT TRUE
            OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2 THEN RETURN false; END IF;
        origin := item->>'origin';
        IF origin IS NULL OR origin NOT IN
            ('user_entry','user_correction','label_extraction','document') THEN RETURN false; END IF;
        IF field IN ('quantity','hours_per_day','effective_load_percent')
            AND origin NOT IN ('user_entry','user_correction') THEN RETURN false; END IF;
        IF (jsonb_typeof(item->'evidence') IN ('string','null')) IS NOT TRUE THEN RETURN false; END IF;
        IF char_length(item->>'evidence') > 2000 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END $$;

CREATE FUNCTION powershift.valid_candidate(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE field text; item jsonb;
BEGIN
    IF jsonb_typeof(value) <> 'object'
        OR (value ?& ARRAY['name','brand','model','watts','voltage','current',
                          'kwh_per_day','notes','visible_evidence']) IS NOT TRUE
        OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 9 THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['name','brand','model','voltage','current'] LOOP
        item := value->field;
        IF jsonb_typeof(item) = 'string' THEN
            IF powershift.valid_text(item #>> '{}') IS NOT TRUE THEN RETURN false; END IF;
        ELSIF jsonb_typeof(item) <> 'null' THEN RETURN false; END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['watts','kwh_per_day'] LOOP
        item := value->field;
        IF jsonb_typeof(item) = 'number' THEN
            IF powershift.finite_numeric((item #>> '{}')::numeric) IS NOT TRUE
                OR (item #>> '{}')::numeric < 0
                OR (field = 'watts' AND (item #>> '{}')::numeric = 0) THEN RETURN false; END IF;
        ELSIF jsonb_typeof(item) <> 'null' THEN RETURN false; END IF;
    END LOOP;
    RETURN jsonb_typeof(value->'notes') = 'string'
       AND jsonb_typeof(value->'visible_evidence') = 'string'
       AND char_length(value->>'notes') <= 2000
       AND char_length(value->>'visible_evidence') <= 2000;
END $$;

CREATE FUNCTION powershift.valid_route_provenance(method text, value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE field text; item jsonb; origin text;
BEGIN
    IF powershift.valid_provenance(value) IS NOT TRUE THEN RETURN false; END IF;
    FOR field, item IN SELECT * FROM jsonb_each(value) LOOP
        origin := item->>'origin';
        IF method = 'manual' AND origin NOT IN ('user_entry','user_correction') THEN RETURN false; END IF;
        IF method = 'document' AND origin NOT IN ('user_entry','user_correction')
            AND NOT (field = 'rated_watts' AND origin = 'document') THEN RETURN false; END IF;
        IF method = 'ai_label_extraction' AND origin = 'document' THEN RETURN false; END IF;
    END LOOP;
    RETURN method IN ('manual','document','ai_label_extraction');
END $$;

CREATE TABLE powershift.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_issuer text NOT NULL CHECK (char_length(identity_issuer) BETWEEN 1 AND 2000),
    identity_subject text NOT NULL CHECK (char_length(identity_subject) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (identity_issuer, identity_subject)
);

CREATE TABLE powershift.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL DEFAULT powershift.current_owner_id() REFERENCES powershift.users(id),
    name text CHECK (name IS NULL OR powershift.valid_text(name)),
    sector text NOT NULL CHECK (sector IN ('home','restaurant','salon','laundry','retail','office','hotel','workshop')),
    currency text NOT NULL CHECK (currency = 'NGN'),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    client_request_id uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_id, id),
    UNIQUE (owner_id, client_request_id)
);

CREATE TABLE powershift.scan_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL DEFAULT powershift.current_owner_id() REFERENCES powershift.users(id),
    profile_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','candidate','failed','confirmed')),
    candidate jsonb,
    consent_notice_version text NOT NULL CHECK (powershift.valid_text(consent_notice_version)),
    consented_at timestamptz NOT NULL CHECK (isfinite(consented_at)),
    expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
    error_code text CHECK (error_code IN ('SCAN_PROVIDER_ERROR','INVALID_SCAN_RESULT','SCAN_TIMEOUT')),
    confirmed_appliance_id uuid,
    confirmed_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (owner_id, profile_id) REFERENCES powershift.profiles(owner_id, id),
    UNIQUE (owner_id, profile_id, id),
    CHECK (expires_at > created_at AND expires_at > consented_at),
    CHECK (candidate IS NULL OR powershift.valid_candidate(candidate)),
    CHECK ((status = 'pending' AND candidate IS NULL AND error_code IS NULL
                AND confirmed_appliance_id IS NULL AND confirmed_at IS NULL)
        OR (status = 'candidate' AND candidate IS NOT NULL AND error_code IS NULL
                AND confirmed_appliance_id IS NULL AND confirmed_at IS NULL)
        OR (status = 'failed' AND candidate IS NULL AND error_code IS NOT NULL
                AND confirmed_appliance_id IS NULL AND confirmed_at IS NULL)
        OR (status = 'confirmed' AND candidate IS NOT NULL AND error_code IS NULL
                AND confirmed_appliance_id IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE TABLE powershift.appliances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL DEFAULT powershift.current_owner_id() REFERENCES powershift.users(id),
    profile_id uuid NOT NULL,
    name text NOT NULL CHECK (powershift.valid_text(name)),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 9007199254740991),
    rated_watts numeric CHECK (rated_watts IS NULL OR (powershift.finite_numeric(rated_watts) AND rated_watts > 0)),
    hours_per_day numeric CHECK (hours_per_day IS NULL OR (powershift.finite_numeric(hours_per_day) AND hours_per_day BETWEEN 0 AND 24)),
    effective_load_percent numeric CHECK (effective_load_percent IS NULL OR (powershift.finite_numeric(effective_load_percent) AND effective_load_percent > 0 AND effective_load_percent <= 100)),
    brand text CHECK (brand IS NULL OR powershift.valid_text(brand)),
    model text CHECK (model IS NULL OR powershift.valid_text(model)),
    source_method text NOT NULL CHECK (source_method IN ('manual','document','ai_label_extraction')),
    source_status text NOT NULL DEFAULT 'customer_confirmed' CHECK (source_status = 'customer_confirmed'),
    source_notes text CHECK (source_notes IS NULL OR char_length(source_notes) <= 2000),
    scan_id uuid,
    field_provenance jsonb NOT NULL CHECK (powershift.valid_route_provenance(source_method, field_provenance)),
    confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    client_request_id uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    calculation_status text GENERATED ALWAYS AS
        (CASE WHEN rated_watts IS NOT NULL AND hours_per_day IS NOT NULL
                   AND effective_load_percent IS NOT NULL THEN 'eligible' ELSE 'incomplete' END) STORED,
    FOREIGN KEY (owner_id, profile_id) REFERENCES powershift.profiles(owner_id, id),
    FOREIGN KEY (owner_id, profile_id, scan_id) REFERENCES powershift.scan_sessions(owner_id, profile_id, id),
    UNIQUE (owner_id, profile_id, id),
    UNIQUE (owner_id, profile_id, client_request_id),
    CHECK ((source_method = 'ai_label_extraction' AND scan_id IS NOT NULL)
        OR (source_method IN ('manual','document') AND scan_id IS NULL))
);

CREATE TABLE powershift.tariff_inputs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL DEFAULT powershift.current_owner_id() REFERENCES powershift.users(id),
    profile_id uuid NOT NULL,
    rate_ngn_per_kwh numeric NOT NULL CHECK (powershift.finite_numeric(rate_ngn_per_kwh) AND rate_ngn_per_kwh >= 0),
    period_days integer NOT NULL CHECK (period_days BETWEEN 1 AND 366),
    provenance text NOT NULL CHECK (provenance = 'user_input'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (owner_id, profile_id) REFERENCES powershift.profiles(owner_id, id),
    UNIQUE (owner_id, profile_id, id)
);

-- Measured observations have their own table. Modeled values live in reports.
CREATE TABLE powershift.energy_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL DEFAULT powershift.current_owner_id() REFERENCES powershift.users(id),
    profile_id uuid NOT NULL,
    appliance_id uuid,
    energy_kwh numeric NOT NULL CHECK (powershift.finite_numeric(energy_kwh) AND energy_kwh >= 0),
    observed_from timestamptz NOT NULL CHECK (isfinite(observed_from)),
    observed_to timestamptz NOT NULL CHECK (isfinite(observed_to)),
    source_method text NOT NULL CHECK (source_method = 'measured'),
    source_notes text NOT NULL CHECK (char_length(source_notes) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (observed_to > observed_from),
    FOREIGN KEY (owner_id, profile_id) REFERENCES powershift.profiles(owner_id, id),
    FOREIGN KEY (owner_id, profile_id, appliance_id)
        REFERENCES powershift.appliances(owner_id, profile_id, id) ON DELETE SET NULL (appliance_id)
);

CREATE TABLE powershift.reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL DEFAULT powershift.current_owner_id() REFERENCES powershift.users(id),
    profile_id uuid NOT NULL,
    tariff_input_id uuid,
    period_days integer NOT NULL CHECK (period_days BETWEEN 1 AND 366),
    contract_version text NOT NULL CHECK (contract_version = '0.1.0'),
    input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
    calculation jsonb NOT NULL CHECK (jsonb_typeof(calculation) = 'object'),
    client_request_id uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (owner_id, profile_id) REFERENCES powershift.profiles(owner_id, id),
    FOREIGN KEY (owner_id, profile_id, tariff_input_id)
        REFERENCES powershift.tariff_inputs(owner_id, profile_id, id),
    UNIQUE (owner_id, profile_id, id),
    UNIQUE (owner_id, profile_id, client_request_id)
);

CREATE TABLE powershift.request_keys (
    owner_id uuid NOT NULL REFERENCES powershift.users(id),
    operation text NOT NULL CHECK (operation IN ('profile.create','appliance.create','report.create')),
    profile_id uuid,
    scope_key uuid GENERATED ALWAYS AS (coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
    client_request_id uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    resource_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, operation, scope_key, client_request_id),
    FOREIGN KEY (owner_id, profile_id) REFERENCES powershift.profiles(owner_id, id),
    CHECK ((operation = 'profile.create' AND profile_id IS NULL)
        OR (operation <> 'profile.create' AND profile_id IS NOT NULL))
);

CREATE TABLE powershift.audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES powershift.users(id),
    actor_id uuid REFERENCES powershift.users(id),
    profile_id uuid,
    entity_type text NOT NULL CHECK (entity_type IN ('profiles','scan_sessions','appliances','tariff_inputs','energy_records','reports')),
    resource_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('created','updated','deleted')),
    resource_version bigint,
    request_id text CHECK (request_id IS NULL OR powershift.valid_text(request_id)),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX profiles_owner_created_idx ON powershift.profiles(owner_id, created_at, id);
CREATE INDEX scans_owner_profile_created_idx ON powershift.scan_sessions(owner_id, profile_id, created_at, id);
CREATE INDEX scans_pending_expiry_idx ON powershift.scan_sessions(expires_at) WHERE status IN ('pending','candidate');
CREATE INDEX appliances_owner_profile_idx ON powershift.appliances(owner_id, profile_id, id);
CREATE INDEX appliances_scan_idx ON powershift.appliances(owner_id, profile_id, scan_id) WHERE scan_id IS NOT NULL;
CREATE INDEX tariffs_owner_profile_idx ON powershift.tariff_inputs(owner_id, profile_id, created_at, id);
CREATE INDEX energy_owner_profile_time_idx ON powershift.energy_records(owner_id, profile_id, observed_from, id);
CREATE INDEX energy_appliance_idx ON powershift.energy_records(owner_id, profile_id, appliance_id) WHERE appliance_id IS NOT NULL;
CREATE INDEX reports_owner_profile_created_idx ON powershift.reports(owner_id, profile_id, created_at, id);
CREATE INDEX reports_tariff_idx ON powershift.reports(owner_id, profile_id, tariff_input_id) WHERE tariff_input_id IS NOT NULL;
CREATE INDEX request_keys_profile_idx ON powershift.request_keys(owner_id, profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX audit_owner_time_idx ON powershift.audit_events(owner_id, occurred_at, id);
CREATE INDEX audit_actor_idx ON powershift.audit_events(actor_id) WHERE actor_id IS NOT NULL;

CREATE FUNCTION powershift.guard_versioned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Resource identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME <> 'profiles' THEN
        IF NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
            RAISE EXCEPTION 'Profile association is immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_TABLE_NAME IN ('profiles','appliances') THEN
        IF NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
            OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
            RAISE EXCEPTION 'Creation request is immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.version <> OLD.version THEN
        RAISE EXCEPTION 'Version is server controlled' USING ERRCODE = '23514';
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := greatest(OLD.updated_at, clock_timestamp());
    RETURN NEW;
END $$;

CREATE FUNCTION powershift.guard_scan() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'confirmed' THEN
            RAISE EXCEPTION 'A scan cannot confirm itself' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF OLD.status IN ('confirmed','failed')
            OR NEW.consent_notice_version IS DISTINCT FROM OLD.consent_notice_version
            OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
            RAISE EXCEPTION 'Final scan evidence and validity are immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'confirmed' AND pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'Scan confirmation requires an appliance write' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'candidate' AND
            (NEW.status <> 'confirmed' OR NEW.candidate IS DISTINCT FROM OLD.candidate) THEN
            RAISE EXCEPTION 'Review candidates are immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION powershift.guard_appliance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE receipt powershift.scan_sessions%ROWTYPE; field text; origin text; candidate_field text;
BEGIN
    IF current_setting('powershift.confirmed', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Explicit customer confirmation is required' USING ERRCODE = '23514';
    END IF;
    NEW.confirmed_at := clock_timestamp();
    IF NEW.source_method = 'ai_label_extraction' THEN
        SELECT * INTO receipt FROM powershift.scan_sessions
         WHERE owner_id = NEW.owner_id AND profile_id = NEW.profile_id AND id = NEW.scan_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Scan association is unavailable' USING ERRCODE = '23503'; END IF;
        IF TG_OP = 'UPDATE' AND OLD.scan_id IS NOT DISTINCT FROM NEW.scan_id
            AND receipt.confirmed_appliance_id = OLD.id AND receipt.status = 'confirmed' THEN
            NULL; -- A correction of this appliance does not consume the receipt again.
        ELSIF receipt.status <> 'candidate' OR receipt.expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'Scan is expired or already consumed' USING ERRCODE = '23514';
        END IF;
        FOREACH field IN ARRAY ARRAY['name','rated_watts','brand','model'] LOOP
            origin := NEW.field_provenance->field->>'origin';
            candidate_field := CASE WHEN field = 'rated_watts' THEN 'watts' ELSE field END;
            IF origin = 'label_extraction' AND
                to_jsonb(NEW)->field IS DISTINCT FROM receipt.candidate->candidate_field THEN
                RAISE EXCEPTION 'A corrected value cannot claim unchanged extraction' USING ERRCODE = '23514';
            END IF;
        END LOOP;
    ELSIF EXISTS (SELECT 1 FROM jsonb_each(NEW.field_provenance) AS p
                    WHERE p.value->>'origin' = 'label_extraction') THEN
        RAISE EXCEPTION 'Label provenance requires a verified scan association' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION powershift.consume_scan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.owner_id IS DISTINCT FROM powershift.current_owner_id() THEN
        RAISE EXCEPTION 'Verified owner context is required' USING ERRCODE = '42501';
    END IF;
    IF NEW.scan_id IS NOT NULL THEN
        UPDATE powershift.scan_sessions SET status = 'confirmed',
            confirmed_appliance_id = NEW.id, confirmed_at = clock_timestamp()
         WHERE owner_id = NEW.owner_id AND profile_id = NEW.profile_id AND id = NEW.scan_id
           AND status = 'candidate' AND expires_at > clock_timestamp();
        IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM powershift.scan_sessions
            WHERE owner_id = NEW.owner_id AND profile_id = NEW.profile_id AND id = NEW.scan_id
              AND status = 'confirmed' AND confirmed_appliance_id = NEW.id) THEN
            RAISE EXCEPTION 'Scan could not be consumed' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION powershift.record_request_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE operation_name text; scope_id uuid;
BEGIN
    IF NEW.owner_id IS DISTINCT FROM powershift.current_owner_id() THEN
        RAISE EXCEPTION 'Verified owner context is required' USING ERRCODE = '42501';
    END IF;
    operation_name := CASE TG_TABLE_NAME WHEN 'profiles' THEN 'profile.create'
        WHEN 'appliances' THEN 'appliance.create' ELSE 'report.create' END;
    IF TG_TABLE_NAME <> 'profiles' THEN scope_id := NEW.profile_id; END IF;
    INSERT INTO powershift.request_keys(owner_id, operation, profile_id,
        client_request_id, request_fingerprint, resource_id)
    VALUES (NEW.owner_id, operation_name, scope_id, NEW.client_request_id, NEW.request_fingerprint, NEW.id);
    RETURN NEW;
END $$;

CREATE FUNCTION powershift.record_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE row_data jsonb; scope_id uuid;
BEGIN
    row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    scope_id := CASE WHEN TG_TABLE_NAME = 'profiles' THEN (row_data->>'id')::uuid
                    ELSE (row_data->>'profile_id')::uuid END;
    INSERT INTO powershift.audit_events(owner_id, actor_id, profile_id, entity_type,
        resource_id, action, resource_version, request_id)
    VALUES ((row_data->>'owner_id')::uuid, powershift.current_owner_id(), scope_id, TG_TABLE_NAME,
        (row_data->>'id')::uuid, CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
        (row_data->>'version')::bigint, nullif(current_setting('powershift.request_id', true), ''));
    RETURN NULL;
END $$;

CREATE FUNCTION powershift.immutable_report() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Saved report content is immutable' USING ERRCODE = '23514'; END $$;

CREATE TRIGGER a_profiles_version BEFORE UPDATE ON powershift.profiles
    FOR EACH ROW EXECUTE FUNCTION powershift.guard_versioned();
CREATE TRIGGER a_scans_version BEFORE UPDATE ON powershift.scan_sessions
    FOR EACH ROW EXECUTE FUNCTION powershift.guard_versioned();
CREATE TRIGGER b_scans_state BEFORE INSERT OR UPDATE ON powershift.scan_sessions
    FOR EACH ROW EXECUTE FUNCTION powershift.guard_scan();
CREATE TRIGGER a_appliances_version BEFORE UPDATE ON powershift.appliances
    FOR EACH ROW EXECUTE FUNCTION powershift.guard_versioned();
CREATE TRIGGER b_appliances_confirmation BEFORE INSERT OR UPDATE ON powershift.appliances
    FOR EACH ROW EXECUTE FUNCTION powershift.guard_appliance();
CREATE TRIGGER appliances_consume AFTER INSERT OR UPDATE ON powershift.appliances
    FOR EACH ROW EXECUTE FUNCTION powershift.consume_scan();
CREATE TRIGGER reports_immutable BEFORE UPDATE ON powershift.reports
    FOR EACH ROW EXECUTE FUNCTION powershift.immutable_report();

DO $$
DECLARE relation_name text;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY['users','profiles','scan_sessions','appliances',
            'tariff_inputs','energy_records','reports','request_keys','audit_events'] LOOP
        EXECUTE format('ALTER TABLE powershift.%I ENABLE ROW LEVEL SECURITY', relation_name);
        EXECUTE format('ALTER TABLE powershift.%I FORCE ROW LEVEL SECURITY', relation_name);
        IF relation_name = 'users' THEN
            EXECUTE 'CREATE POLICY owner_scope ON powershift.users TO PUBLIC '
                || 'USING (id = (SELECT powershift.current_owner_id())) '
                || 'WITH CHECK (id = (SELECT powershift.current_owner_id()))';
        ELSE
            EXECUTE format('CREATE POLICY owner_scope ON powershift.%I TO PUBLIC '
                || 'USING (owner_id = (SELECT powershift.current_owner_id())) '
                || 'WITH CHECK (owner_id = (SELECT powershift.current_owner_id()))', relation_name);
        END IF;
    END LOOP;
    FOREACH relation_name IN ARRAY ARRAY['profiles','scan_sessions','appliances',
            'tariff_inputs','energy_records','reports'] LOOP
        EXECUTE format('CREATE TRIGGER z_audit AFTER INSERT OR UPDATE OR DELETE ON powershift.%I '
            || 'FOR EACH ROW EXECUTE FUNCTION powershift.record_audit()', relation_name);
    END LOOP;
    FOREACH relation_name IN ARRAY ARRAY['profiles','appliances','reports'] LOOP
        EXECUTE format('CREATE TRIGGER request_key AFTER INSERT ON powershift.%I '
            || 'FOR EACH ROW EXECUTE FUNCTION powershift.record_request_key()', relation_name);
    END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA powershift FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA powershift FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA powershift FROM PUBLIC;
GRANT USAGE ON SCHEMA powershift TO powershift_app;
GRANT EXECUTE ON FUNCTION powershift.current_owner_id(), powershift.finite_numeric(numeric),
    powershift.valid_text(text), powershift.valid_provenance(jsonb), powershift.valid_candidate(jsonb),
    powershift.valid_route_provenance(text, jsonb) TO powershift_app;
GRANT SELECT ON ALL TABLES IN SCHEMA powershift TO powershift_app;
GRANT INSERT, UPDATE ON powershift.profiles, powershift.scan_sessions, powershift.appliances TO powershift_app;
GRANT DELETE ON powershift.appliances TO powershift_app;
GRANT INSERT ON powershift.tariff_inputs, powershift.energy_records, powershift.reports TO powershift_app;
-- No role membership/login, schema CREATE, TRUNCATE, audit/request-key writes,
-- user provisioning, report mutation, or automatic retention policy is granted.
