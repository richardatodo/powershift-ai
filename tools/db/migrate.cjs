'use strict';

const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const DEFAULT_MIGRATIONS = path.resolve(__dirname, '../../backend/persistence/migrations');
const MAX_VERSION = 9223372036854775807n;
const LOCK_ID = '7083920466513041';

function compareVersions(left, right) {
  const a = BigInt(left.version);
  const b = BigInt(right.version);
  return a < b ? -1 : a > b ? 1 : 0;
}

function checksum(upBytes, downBytes) {
  // Length prefixes and a missing-file marker make the byte boundaries explicit.
  const hash = createHash('sha256');
  hash.update(`powershift-migration-v1\0up:${upBytes.length}\0`);
  hash.update(upBytes);
  hash.update(downBytes === null ? '\0down:missing\0' : `\0down:${downBytes.length}\0`);
  if (downBytes !== null) hash.update(downBytes);
  return hash.digest('hex');
}

function loadMigrations(directory = DEFAULT_MIGRATIONS) {
  const groups = new Map();
  for (const filename of readdirSync(directory)) {
    if (!filename.endsWith('.sql')) continue;
    const match = /^(\d+)_([a-z][a-z0-9_]*)\.(up|down)\.sql$/.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    const versionNumber = BigInt(match[1]);
    if (versionNumber <= 0n || versionNumber > MAX_VERSION) {
      throw new Error(`Migration version must be a positive PostgreSQL bigint: ${filename}`);
    }
    const version = versionNumber.toString();
    const entry = groups.get(version) || { version, name: match[2] };
    if (entry.name !== match[2] || entry[`${match[3]}Path`]) {
      throw new Error(`Duplicate migration version: ${version}`);
    }
    entry[`${match[3]}Path`] = path.resolve(directory, filename);
    groups.set(version, entry);
  }
  return [...groups.values()].sort(compareVersions).map((entry) => {
    if (!entry.upPath) throw new Error(`Migration ${entry.version} has a down file without an up file`);
    const upBytes = readFileSync(entry.upPath);
    const downBytes = entry.downPath ? readFileSync(entry.downPath) : null;
    return Object.freeze({
      ...entry,
      up: upBytes.toString('utf8'),
      down: downBytes === null ? null : downBytes.toString('utf8'),
      checksum: checksum(upBytes, downBytes),
    });
  });
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations)) throw new TypeError('migrations must be an array');
  let previous = 0n;
  for (const item of migrations) {
    if (!item || !/^\d+$/.test(item.version || '') || BigInt(item.version) <= previous
        || BigInt(item.version) > MAX_VERSION || !/^[a-z][a-z0-9_]*$/.test(item.name || '')
        || typeof item.up !== 'string' || !(item.down === null || typeof item.down === 'string')
        || !/^[0-9a-f]{64}$/.test(item.checksum || '')) {
      throw new Error('Migrations must have ordered unique versions, names, SQL and SHA256 checksums');
    }
    if (item.checksum !== checksum(Buffer.from(item.up), item.down === null ? null : Buffer.from(item.down))) {
      throw new Error(`Migration ${item.version} checksum does not match supplied SQL`);
    }
    previous = BigInt(item.version);
  }
}

async function migrate(db, options = {}) {
  const { direction = 'up', migrations = loadMigrations(), steps } = options;
  if (!db || typeof db.query !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('Database adapter must provide query(sql, parameters) and exec(sql)');
  }
  if (!['up', 'down'].includes(direction)) throw new Error('direction must be up or down');
  if (steps !== undefined && (!Number.isSafeInteger(steps) || steps <= 0)) {
    throw new Error('steps must be a positive safe integer');
  }
  validateMigrations(migrations);
  let transactionStarted = false;
  try {
    await db.exec('BEGIN');
    transactionStarted = true;
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_ID]);
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS powershift_meta;
      CREATE TABLE IF NOT EXISTS powershift_meta.schema_migrations (
        version bigint PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `);
    const history = (await db.query(`
      SELECT version::text AS version, name, checksum
      FROM powershift_meta.schema_migrations ORDER BY version
    `)).rows;
    for (let index = 0; index < history.length; index += 1) {
      const actual = history[index];
      const expected = migrations[index];
      if (!expected || actual.version !== expected.version || actual.name !== expected.name) {
        throw new Error(`Unknown or out-of-order migration history at version ${actual.version}`);
      }
      if (actual.checksum !== expected.checksum) {
        throw new Error(`Applied migration ${actual.version} checksum changed; restore its original up and down files`);
      }
    }
    const selected = direction === 'up'
      ? migrations.slice(history.length, steps === undefined ? undefined : history.length + steps)
      : migrations.slice(0, history.length).reverse().slice(0, steps === undefined ? 1 : steps);
    if (direction === 'down' && selected.some((item) => item.down === null)) {
      throw new Error('Cannot roll back a migration without its down SQL file');
    }
    for (const item of selected) {
      await db.exec(direction === 'up' ? item.up : item.down);
      if (direction === 'up') {
        await db.query(`
          INSERT INTO powershift_meta.schema_migrations(version, name, checksum)
          VALUES ($1::bigint, $2, $3)
        `, [item.version, item.name, item.checksum]);
      } else {
        await db.query('DELETE FROM powershift_meta.schema_migrations WHERE version = $1::bigint', [item.version]);
      }
    }
    await db.exec('COMMIT');
    transactionStarted = false;
    return { direction, versions: selected.map((item) => item.version) };
  } catch (error) {
    if (transactionStarted) {
      try { await db.exec('ROLLBACK'); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Migration failed and rollback also failed');
      }
    }
    throw error;
  }
}

module.exports = { loadMigrations, migrate };
