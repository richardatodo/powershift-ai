-- Only the trusted backend calls this after verifying the issuer's JWT.
-- The migration owner may provision identities even when FORCE RLS is enabled.
DO $$ BEGIN
    EXECUTE format('CREATE POLICY identity_provisioner ON powershift.users TO %I '
        || 'USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE FUNCTION powershift.resolve_identity(issuer text, subject text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_uuid uuid;
BEGIN
    IF issuer IS NULL OR subject IS NULL OR issuer !~ '\S' OR subject !~ '\S'
        OR char_length(issuer) > 2000 OR char_length(subject) > 2000 THEN
        RAISE EXCEPTION 'Verified identity is required' USING ERRCODE = '23514';
    END IF;
    INSERT INTO powershift.users(identity_issuer, identity_subject) VALUES (issuer, subject)
    ON CONFLICT (identity_issuer, identity_subject)
        DO UPDATE SET identity_subject = EXCLUDED.identity_subject
    RETURNING id INTO owner_uuid;
    RETURN owner_uuid;
END $$;
REVOKE EXECUTE ON FUNCTION powershift.resolve_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION powershift.resolve_identity(text, text) TO powershift_app;
