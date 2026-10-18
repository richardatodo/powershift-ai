-- Development rollback only; this destroys the application's persisted data.
-- The migration runner must verify history/checksum and wrap this in a transaction.
DROP SCHEMA powershift CASCADE;
DROP ROLE powershift_app;
