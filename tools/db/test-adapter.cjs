'use strict';

// Integration-test infrastructure only. This module is not an application driver.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const nativeUrl = process.env.POWERSHIFT_TEST_DATABASE_URL;
const nativeMode = Boolean(nativeUrl);
const testRoles = ['powershift_app', 'm4_migration_owner'];
const testLock = '7083920466513042';

function pinnedPackage(name, root, version) {
  if (!root) throw new Error(`Set the TEMP dependency root for ${name}@${version}`);
  const entry = require.resolve(name, { paths: [root] });
  const manifest = path.resolve(path.dirname(entry), '../package.json');
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, version, `Use reviewed ${name}@${version}`);
  return require(entry);
}

let Client;
let PGlite;
if (nativeMode) {
  if (process.env.POWERSHIFT_NATIVE_TESTS !== '1') {
    throw new Error('Native tests create/drop disposable databases and test roles; explicitly set POWERSHIFT_NATIVE_TESTS=1 for an isolated test cluster');
  }
  const parsed = new URL(nativeUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Native test URL must use PostgreSQL');
  ({ Client } = pinnedPackage('pg', process.env.POWERSHIFT_PG_ROOT, '8.16.3'));
} else {
  ({ PGlite } = pinnedPackage('@electric-sql/pglite', process.env.POWERSHIFT_PGLITE_ROOT, '0.5.10'));
}

async function createTestDatabase() {
  if (!nativeMode) return PGlite.create();
  const databaseName = `powershift_m4_test_${process.pid}_${randomBytes(8).toString('hex')}`;
  assert.match(databaseName, /^powershift_m4_test_[0-9]+_[a-f0-9]{16}$/);
  const admin = new Client({ connectionString: nativeUrl });
  let client;
  let databaseCreated = false;
  let baselineVerified = false;
  await admin.connect();
  try {
    // Schema migrations use fixed cluster-role names. Serialize isolated fixtures
    // and refuse to touch any role that existed before the fixture was created.
    await admin.query('SELECT pg_advisory_lock($1::bigint)', [testLock]);
    const roles = await admin.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [testRoles]);
    if (roles.rows.length) throw new Error('Disposable test cluster already contains a reserved migration-test role');
    baselineVerified = true;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const target = new URL(nativeUrl);
    target.pathname = `/${databaseName}`;
    client = new Client({ connectionString: target.toString() });
    await client.connect();
  } catch (error) {
    if (client) await client.end();
    if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  let closed = false;
  return {
    async query(sql, parameters) { return client.query(sql, parameters); },
    async exec(sql) { return client.query(sql); },
    async connect() {
      if (closed) throw new Error('Test database is closed');
      const target = new URL(nativeUrl);
      target.pathname = `/${databaseName}`;
      const connection = new Client({ connectionString: target.toString() });
      await connection.connect();
      return connection;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.end();
        if (databaseCreated) {
          assert.match(databaseName, /^powershift_m4_test_[0-9]+_[a-f0-9]{16}$/);
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        }
        if (baselineVerified) {
          // These names were proved absent before creating this isolated fixture.
          for (const role of testRoles) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        }
      } finally {
        await admin.end(); // Releases the session advisory lock as well.
      }
    },
  };
}

module.exports = { createTestDatabase, nativeMode };
