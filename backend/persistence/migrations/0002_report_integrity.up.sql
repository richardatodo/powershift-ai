-- Reports store immutable engine output and the confirmed inputs behind it.
-- This migration validates consistency; it does not reimplement kWh arithmetic.
CREATE FUNCTION powershift.valid_fixed(value jsonb, places integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
    SELECT value = 'null'::jsonb OR
        (jsonb_typeof(value) = 'string' AND (value #>> '{}') !~ '\s'
         AND (value #>> '{}') ~ ('^(0|[1-9][0-9]*)\.[0-9]{' || places || '}$'))
$$;

CREATE FUNCTION powershift.guard_report() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    snap jsonb := NEW.input_snapshot;
    calc jsonb := NEW.calculation;
    inputs jsonb; results jsonb; item jsonb; result_row jsonb; live powershift.appliances%ROWTYPE;
    tariff powershift.tariff_inputs%ROWTYPE;
    field text; idx integer; eligible integer := 0; incomplete integer := 0;
    issue jsonb; warning jsonb; missing_count integer; issue_paths text[];
    warning_codes text[] := ARRAY[]::text[];
    ids uuid[] := ARRAY[]::uuid[]; input_id uuid;
    appliance_keys text[] := ARRAY['id','profile_id','name','quantity','rated_watts',
        'hours_per_day','effective_load_percent','brand','model','source_method','source_notes',
        'scan_id','source_status','version','confirmed_at','created_at','updated_at',
        'field_provenance','calculation_status','calculated_daily_kwh'];
BEGIN
    IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
        RAISE EXCEPTION 'Report creation requires a consistent transaction snapshot' USING ERRCODE = '23514';
    END IF;
    IF NEW.owner_id IS DISTINCT FROM powershift.current_owner_id() THEN
        RAISE EXCEPTION 'Verified owner context is required' USING ERRCODE = '42501';
    END IF;
    IF (snap ?& ARRAY['appliances','period_days','rate_ngn_per_kwh','tariff_provenance']) IS NOT TRUE
        OR (SELECT count(*) FROM jsonb_object_keys(snap)) <> 4
        OR (calc ?& ARRAY['contract_version','estimate','period_days','rate_ngn_per_kwh',
            'tariff_provenance','rows','counts','totals','warnings','assumptions']) IS NOT TRUE
        OR (SELECT count(*) FROM jsonb_object_keys(calc)) <> 10 THEN
        RAISE EXCEPTION 'Invalid report shape' USING ERRCODE = '23514';
    END IF;
    IF (calc->>'contract_version' = NEW.contract_version AND calc->'estimate' = 'true'::jsonb
        AND jsonb_typeof(calc->'period_days') = 'number'
        AND jsonb_typeof(snap->'period_days') = 'number'
        AND (calc->>'period_days')::numeric = NEW.period_days
        AND (snap->>'period_days')::numeric = NEW.period_days) IS NOT TRUE THEN
        RAISE EXCEPTION 'Report policy or period mismatch' USING ERRCODE = '23514';
    END IF;
    IF snap->'rate_ngn_per_kwh' IS DISTINCT FROM calc->'rate_ngn_per_kwh'
        OR snap->'tariff_provenance' IS DISTINCT FROM calc->'tariff_provenance' THEN
        RAISE EXCEPTION 'Report tariff mismatch' USING ERRCODE = '23514';
    END IF;
    IF calc->'rate_ngn_per_kwh' = 'null'::jsonb THEN
        IF NEW.tariff_input_id IS NOT NULL OR calc->'tariff_provenance' <> 'null'::jsonb THEN
            RAISE EXCEPTION 'Absent tariff cannot acquire provenance' USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT * INTO tariff FROM powershift.tariff_inputs WHERE owner_id = NEW.owner_id
            AND profile_id = NEW.profile_id AND id = NEW.tariff_input_id;
        IF NOT FOUND OR (jsonb_typeof(calc->'rate_ngn_per_kwh') = 'number'
            AND (calc->>'rate_ngn_per_kwh')::numeric = tariff.rate_ngn_per_kwh
            AND tariff.period_days = NEW.period_days
            AND calc->>'tariff_provenance' = 'user_input') IS NOT TRUE THEN
            RAISE EXCEPTION 'Report must reference its owned tariff input' USING ERRCODE = '23514';
        END IF;
    END IF;
    inputs := snap->'appliances'; results := calc->'rows';
    IF (jsonb_typeof(inputs) = 'array' AND jsonb_typeof(results) = 'array'
        AND jsonb_array_length(inputs) = jsonb_array_length(results)
        AND jsonb_typeof(calc->'counts') = 'object' AND jsonb_typeof(calc->'totals') = 'object'
        AND jsonb_typeof(calc->'warnings') = 'array' AND jsonb_typeof(calc->'assumptions') = 'array'
        AND jsonb_array_length(calc->'assumptions') > 0) IS NOT TRUE THEN
        RAISE EXCEPTION 'Invalid report collections' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(calc->'assumptions') AS a
        WHERE jsonb_typeof(a.value) <> 'string' OR (a.value #>> '{}') !~ '\S'
            OR (a.value #>> '{}') ~ '^\s' OR (a.value #>> '{}') ~ '\s$') THEN
        RAISE EXCEPTION 'Report assumptions must be disclosed' USING ERRCODE = '23514';
    END IF;
    FOR warning IN SELECT value FROM jsonb_array_elements(calc->'warnings') LOOP
        IF (jsonb_typeof(warning) = 'object' AND warning ?& ARRAY['code','message']
            AND (SELECT count(*) FROM jsonb_object_keys(warning)) = 2
            AND warning->>'code' IN ('INCOMPLETE_RECORDS','NO_ELIGIBLE_RECORDS',
                'RATED_POWER_ESTIMATE','ROUNDING_APPLIED')
            AND jsonb_typeof(warning->'message') = 'string'
            AND warning->>'message' ~ '\S' AND warning->>'message' !~ '^\s'
            AND warning->>'message' !~ '\s$') IS NOT TRUE THEN
            RAISE EXCEPTION 'Invalid report warning' USING ERRCODE = '23514';
        END IF;
        IF warning->>'code' = ANY(warning_codes) THEN
            RAISE EXCEPTION 'Duplicate report warning' USING ERRCODE = '23514';
        END IF;
        warning_codes := array_append(warning_codes, warning->>'code');
    END LOOP;
    IF jsonb_array_length(inputs) <> (SELECT count(*) FROM powershift.appliances
            WHERE owner_id = NEW.owner_id AND profile_id = NEW.profile_id) THEN
        RAISE EXCEPTION 'Report snapshot omits stored records' USING ERRCODE = '23514';
    END IF;
    FOR idx IN 0 .. jsonb_array_length(inputs) - 1 LOOP
        item := inputs->idx; result_row := results->idx;
        IF (jsonb_typeof(item) = 'object' AND item ?& appliance_keys) IS NOT TRUE
            OR (SELECT count(*) FROM jsonb_object_keys(item)) <> cardinality(appliance_keys) THEN
            RAISE EXCEPTION 'Invalid appliance snapshot' USING ERRCODE = '23514';
        END IF;
        input_id := (item->>'id')::uuid;
        IF input_id = ANY(ids) THEN RAISE EXCEPTION 'Duplicate snapshot identity' USING ERRCODE = '23514'; END IF;
        ids := array_append(ids, input_id);
        SELECT * INTO live FROM powershift.appliances WHERE owner_id = NEW.owner_id
            AND profile_id = NEW.profile_id AND id = input_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Snapshot appliance is unavailable' USING ERRCODE = '23503'; END IF;
        FOREACH field IN ARRAY ARRAY['id','profile_id','name','quantity','rated_watts','hours_per_day',
            'effective_load_percent','brand','model','source_method','source_notes','scan_id',
            'source_status','version','field_provenance','calculation_status'] LOOP
            IF item->field IS DISTINCT FROM to_jsonb(live)->field THEN
                RAISE EXCEPTION 'Snapshot does not match stored input version' USING ERRCODE = '23514';
            END IF;
        END LOOP;
        FOREACH field IN ARRAY ARRAY['created_at','updated_at','confirmed_at'] LOOP
            IF (jsonb_typeof(item->field) = 'string'
                AND isfinite((item->>field)::timestamptz)
                AND (item->>field)::timestamptz = (to_jsonb(live)->>field)::timestamptz) IS NOT TRUE THEN
                RAISE EXCEPTION 'Snapshot timestamp does not match stored record' USING ERRCODE = '23514';
            END IF;
        END LOOP;
        IF (jsonb_typeof(result_row) = 'object'
            AND result_row ?& ARRAY['input_index','id','status','daily_kwh','period_kwh','issues']
            AND (SELECT count(*) FROM jsonb_object_keys(result_row)) = 6
            AND jsonb_typeof(result_row->'input_index') = 'number'
            AND (result_row->>'input_index')::numeric = idx
            AND result_row->'id' = item->'id'
            AND result_row->>'status' = live.calculation_status
            AND jsonb_typeof(result_row->'issues') = 'array'
            AND powershift.valid_fixed(item->'calculated_daily_kwh', 6)
            AND item->'calculated_daily_kwh' = result_row->'daily_kwh'
            AND powershift.valid_fixed(result_row->'daily_kwh', 6)
            AND powershift.valid_fixed(result_row->'period_kwh', 6)) IS NOT TRUE THEN
            RAISE EXCEPTION 'Report result does not match its input snapshot' USING ERRCODE = '23514';
        END IF;
        IF live.calculation_status = 'eligible' THEN
            eligible := eligible + 1;
            IF result_row->'daily_kwh' = 'null'::jsonb OR result_row->'period_kwh' = 'null'::jsonb
                OR jsonb_array_length(result_row->'issues') <> 0 THEN
                RAISE EXCEPTION 'Eligible report rows require energy' USING ERRCODE = '23514';
            END IF;
        ELSE
            incomplete := incomplete + 1;
            IF result_row->'daily_kwh' <> 'null'::jsonb OR result_row->'period_kwh' <> 'null'::jsonb
                OR jsonb_array_length(result_row->'issues') = 0 THEN
                RAISE EXCEPTION 'Incomplete report rows must remain excluded' USING ERRCODE = '23514';
            END IF;
            issue_paths := ARRAY[]::text[];
            FOR issue IN SELECT value FROM jsonb_array_elements(result_row->'issues') LOOP
                IF (jsonb_typeof(issue) = 'object' AND issue ?& ARRAY['path','code','message']
                    AND (SELECT count(*) FROM jsonb_object_keys(issue)) = 3
                    AND issue->>'code' = 'MISSING_VALUE'
                    AND issue->>'path' IN ('/rated_watts','/hours_per_day','/effective_load_percent')
                    AND item->(substring(issue->>'path' FROM 2)) = 'null'::jsonb
                    AND jsonb_typeof(issue->'message') = 'string'
                    AND issue->>'message' ~ '\S' AND issue->>'message' !~ '^\s'
                    AND issue->>'message' !~ '\s$') IS NOT TRUE THEN
                    RAISE EXCEPTION 'Invalid incomplete-row issue' USING ERRCODE = '23514';
                END IF;
                IF issue->>'path' = ANY(issue_paths) THEN
                    RAISE EXCEPTION 'Duplicate incomplete-row issue' USING ERRCODE = '23514';
                END IF;
                issue_paths := array_append(issue_paths, issue->>'path');
            END LOOP;
            SELECT count(*) INTO missing_count FROM unnest(ARRAY['rated_watts',
                'hours_per_day','effective_load_percent']) AS f WHERE item->f = 'null'::jsonb;
            IF cardinality(issue_paths) <> missing_count THEN
                RAISE EXCEPTION 'Missing inputs must be disclosed' USING ERRCODE = '23514';
            END IF;
        END IF;
    END LOOP;
    IF NOT ('RATED_POWER_ESTIMATE' = ANY(warning_codes))
        OR (incomplete > 0) IS DISTINCT FROM ('INCOMPLETE_RECORDS' = ANY(warning_codes))
        OR (eligible = 0) IS DISTINCT FROM ('NO_ELIGIBLE_RECORDS' = ANY(warning_codes)) THEN
        RAISE EXCEPTION 'Required report warnings do not reconcile' USING ERRCODE = '23514';
    END IF;
    IF (calc->'counts' = jsonb_build_object('total', eligible + incomplete, 'eligible', eligible,
        'incomplete', incomplete, 'invalid', 0, 'unconfirmed', 0)) IS NOT TRUE THEN
        RAISE EXCEPTION 'Report counts do not reconcile' USING ERRCODE = '23514';
    END IF;
    IF ((calc->'totals') ?& ARRAY['daily_kwh','period_kwh','grid_equivalent_cost_ngn']) IS NOT TRUE
        OR (SELECT count(*) FROM jsonb_object_keys(calc->'totals')) <> 3
        OR powershift.valid_fixed(calc->'totals'->'daily_kwh', 6) IS NOT TRUE
        OR powershift.valid_fixed(calc->'totals'->'period_kwh', 6) IS NOT TRUE
        OR powershift.valid_fixed(calc->'totals'->'grid_equivalent_cost_ngn', 2) IS NOT TRUE THEN
        RAISE EXCEPTION 'Invalid report totals' USING ERRCODE = '23514';
    END IF;
    IF eligible = 0 THEN
        IF calc->'totals' <> '{"daily_kwh":null,"period_kwh":null,"grid_equivalent_cost_ngn":null}'::jsonb THEN
            RAISE EXCEPTION 'No eligible input means unknown totals' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF calc->'totals'->'daily_kwh' = 'null'::jsonb OR calc->'totals'->'period_kwh' = 'null'::jsonb
            OR ((calc->'rate_ngn_per_kwh' = 'null'::jsonb)
                IS DISTINCT FROM (calc->'totals'->'grid_equivalent_cost_ngn' = 'null'::jsonb)) THEN
            RAISE EXCEPTION 'Report cost/energy presence is inconsistent' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_parameter_value THEN
    RAISE EXCEPTION 'Invalid report value representation' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER reports_snapshot BEFORE INSERT ON powershift.reports
    FOR EACH ROW EXECUTE FUNCTION powershift.guard_report();
REVOKE EXECUTE ON FUNCTION powershift.valid_fixed(jsonb, integer), powershift.guard_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION powershift.valid_fixed(jsonb, integer) TO powershift_app;
