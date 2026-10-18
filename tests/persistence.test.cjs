'use strict';

const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, test } = require('node:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { loadMigrations, migrate } = require('../tools/db/migrate.cjs');
const { createTestDatabase, nativeMode } = require('../tools/db/test-adapter.cjs');
const migrationDirectory = path.resolve(__dirname, '../backend/persistence/migrations');

describe('transactional migration runner', { concurrency: false }, () => {
  let db;
  let fixtureDirectory;
  beforeEach(async () => {
    db = await createTestDatabase();
    fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'powershift-migration-fixture-'));
  });
  afterEach(async () => {
    await db.close();
    assert.equal(path.dirname(path.resolve(fixtureDirectory)), path.resolve(tmpdir()));
    assert.ok(path.basename(fixtureDirectory).startsWith('powershift-migration-fixture-'));
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });
  function fixture(version, up, down = null) {
    writeFileSync(path.join(fixtureDirectory, `${version}_fixture.up.sql`), up);
    if (down !== null) writeFileSync(path.join(fixtureDirectory, `${version}_fixture.down.sql`), down);
    return loadMigrations(fixtureDirectory);
  }
  async function hasTable(table) {
    return (await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [table])).rows[0].present;
  }
  test('fresh domain up, repeat no-op, down and up retain a correct journal', async () => {
    const migrations = loadMigrations(migrationDirectory);
    const versions = migrations.map((item) => item.version);
    assert.deepEqual((await migrate(db, { migrations })).versions, versions);
    assert.equal(await hasTable('powershift.profiles'), true);
    assert.deepEqual((await migrate(db, { migrations })).versions, []);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift_meta.schema_migrations')).rows[0].n, migrations.length);
    assert.deepEqual((await migrate(db, { direction: 'down', migrations })).versions, [versions.at(-1)]);
    assert.equal(await hasTable('powershift.profiles'), true);
    assert.deepEqual((await migrate(db, { migrations })).versions, [versions.at(-1)]);
    assert.deepEqual((await migrate(db, { direction: 'down', migrations, steps: migrations.length })).versions, [...versions].reverse());
    assert.equal(await hasTable('powershift.profiles'), false);
    assert.equal(await hasTable('powershift_meta.schema_migrations'), true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'powershift_app'")).rows[0].n, 0);
    assert.deepEqual((await migrate(db, { migrations })).versions, versions);
  });
  test('a failing up rolls back all pending DDL and the newly created journal', async () => {
    fixture('0001', 'CREATE TABLE rollback_probe(id int);', 'DROP TABLE rollback_probe;');
    const migrations = fixture('0002', 'CREATE TABLE rollback_probe_second(id int); SELECT nonexistent_function();', 'DROP TABLE rollback_probe_second;');
    await assert.rejects(migrate(db, { migrations }), /nonexistent_function/);
    assert.equal(await hasTable('rollback_probe'), false);
    assert.equal(await hasTable('rollback_probe_second'), false);
    assert.equal(await hasTable('powershift_meta.schema_migrations'), false);
  });
  test('a failing down restores dropped objects and retains the journal row', async () => {
    const migrations = fixture('0001', 'CREATE TABLE down_rollback_probe(id int);', 'DROP TABLE down_rollback_probe; SELECT nonexistent_function();');
    await migrate(db, { migrations });
    await assert.rejects(migrate(db, { direction: 'down', migrations }), /nonexistent_function/);
    assert.equal(await hasTable('down_rollback_probe'), true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift_meta.schema_migrations')).rows[0].n, 1);
  });
  test('SHA256 detects byte changes to either applied SQL file', async () => {
    const migrations = fixture('0001', 'CREATE TABLE drift_probe(id int);', 'DROP TABLE drift_probe;');
    await migrate(db, { migrations });
    writeFileSync(path.join(fixtureDirectory, '0001_fixture.up.sql'), `${migrations[0].up}\n`);
    await assert.rejects(migrate(db, { migrations: loadMigrations(fixtureDirectory) }), /checksum changed/);
    writeFileSync(path.join(fixtureDirectory, '0001_fixture.up.sql'), migrations[0].up);
    writeFileSync(path.join(fixtureDirectory, '0001_fixture.down.sql'), `${migrations[0].down}\n`);
    await assert.rejects(migrate(db, { direction: 'down', migrations: loadMigrations(fixtureDirectory) }), /checksum changed/);
    assert.equal(await hasTable('drift_probe'), true);
  });
  test('unknown and non-prefix migration histories are refused', async () => {
    let migrations = fixture('0002', 'CREATE TABLE unknown_probe(id int);', 'DROP TABLE unknown_probe;');
    await migrate(db, { migrations });
    await assert.rejects(migrate(db, { migrations: [] }), /Unknown or out-of-order/);
    migrations = fixture('0001', 'CREATE TABLE predecessor_probe(id int);', 'DROP TABLE predecessor_probe;');
    await assert.rejects(migrate(db, { migrations }), /Unknown or out-of-order/);
    assert.equal(await hasTable('predecessor_probe'), false);
  });
  test('steps are bounded and rollback defaults to one migration', async () => {
    fixture('0001', 'CREATE TABLE step_one(id int);', 'DROP TABLE step_one;');
    const migrations = fixture('0002', 'CREATE TABLE step_two(id int);', 'DROP TABLE step_two;');
    assert.deepEqual((await migrate(db, { migrations, steps: 1 })).versions, ['1']);
    assert.equal(await hasTable('step_two'), false);
    assert.deepEqual((await migrate(db, { migrations })).versions, ['2']);
    assert.deepEqual((await migrate(db, { migrations, direction: 'down' })).versions, ['2']);
    assert.equal(await hasTable('step_one'), true);
    await assert.rejects(migrate(db, { migrations, steps: 0 }), /positive safe integer/);
    await assert.rejects(migrate(db, { migrations, direction: 'sideways' }), /direction/);
  });
  test('missing down SQL is refused without changing the applied schema', async () => {
    const migrations = fixture('0001', 'CREATE TABLE no_down_probe(id int);');
    await migrate(db, { migrations });
    await assert.rejects(migrate(db, { migrations, direction: 'down' }), /without its down SQL/);
    assert.equal(await hasTable('no_down_probe'), true);
  });
  test('migration loader rejects duplicate versions, orphan downs and invalid names', () => {
    fixture('0001', 'SELECT 1;');
    writeFileSync(path.join(fixtureDirectory, '1_other.up.sql'), 'SELECT 1;');
    assert.throws(() => loadMigrations(fixtureDirectory), /Duplicate/);
    rmSync(path.join(fixtureDirectory, '1_other.up.sql'));
    writeFileSync(path.join(fixtureDirectory, '0002_orphan.down.sql'), 'SELECT 1;');
    assert.throws(() => loadMigrations(fixtureDirectory), /without an up/);
    rmSync(path.join(fixtureDirectory, '0002_orphan.down.sql'));
    writeFileSync(path.join(fixtureDirectory, 'not-a-migration.sql'), 'SELECT 1;');
    assert.throws(() => loadMigrations(fixtureDirectory), /Invalid migration filename/);
  });
  test('a non-superuser migration owner can maintain request, audit and scan trigger writes under FORCE RLS', async () => {
    const databaseName = (await db.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(databaseName, /^[a-z0-9_]+$/);
    await db.exec(`CREATE ROLE m4_migration_owner NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE; GRANT CREATE ON DATABASE "${databaseName}" TO m4_migration_owner; SET ROLE m4_migration_owner`);
    await migrate(db, { migrations: loadMigrations(migrationDirectory) });
    await db.exec('RESET ROLE');
    const owner = randomUUID();
    const profile = randomUUID();
    await db.query('INSERT INTO powershift.users(id, identity_issuer, identity_subject) VALUES ($1, $2, $3)', [owner, 'test', randomUUID()]);
    await db.exec('BEGIN');
    await db.query("SELECT set_config('powershift.owner_id', $1, true), set_config('powershift.confirmed', 'true', true)", [owner]);
    await db.exec('SET LOCAL ROLE powershift_app');
    await db.query("INSERT INTO powershift.profiles(id,name,sector,currency,client_request_id,request_fingerprint) VALUES ($1,'Owner RLS test','home','NGN',$2,$3)", [profile, randomUUID(), 'a'.repeat(64)]);
    const scanId = randomUUID();
    const candidate = { name: 'Fan', brand: null, model: null, watts: 100, voltage: null, current: null, kwh_per_day: null, notes: '', visible_evidence: '100 W' };
    await db.query("INSERT INTO powershift.scan_sessions(id,profile_id,status,candidate,consent_notice_version,consented_at,expires_at) VALUES ($1,$2,'candidate',$3,'v1',now(),now()+interval '1 hour')", [scanId, profile, JSON.stringify(candidate)]);
    const fieldProvenance = Object.fromEntries(['name','quantity','rated_watts','hours_per_day','effective_load_percent','brand','model'].map((field) => [field,{origin:'user_entry',evidence:null}]));
    await db.query("INSERT INTO powershift.appliances(profile_id,name,quantity,rated_watts,hours_per_day,effective_load_percent,source_method,scan_id,field_provenance,client_request_id,request_fingerprint) VALUES ($1,'Fan',1,100,8,50,'ai_label_extraction',$2,$3,$4,$5)", [profile,scanId,JSON.stringify(fieldProvenance),randomUUID(),'a'.repeat(64)]);
    assert.equal((await db.query('SELECT status FROM powershift.scan_sessions WHERE id=$1', [scanId])).rows[0].status, 'confirmed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.request_keys')).rows[0].n, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.audit_events')).rows[0].n, 4);
    await db.exec('ROLLBACK');
  });
});

if (nativeMode) describe('native PostgreSQL concurrent transactions', { concurrency: false }, () => {
  let db;
  let connections;
  let owner;
  let profile;
  const fingerprint = 'b'.repeat(64);
  const provenance = JSON.stringify(Object.fromEntries(['name','quantity','rated_watts','hours_per_day','effective_load_percent','brand','model'].map((field)=>[field,{origin:'user_entry',evidence:null}])));
  beforeEach(async () => {
    db = await createTestDatabase();
    connections = [];
  });
  afterEach(async () => {
    await Promise.all(connections.map((connection) => connection.end()));
    await db.close();
  });
  async function connection() {
    const client = await db.connect();
    connections.push(client);
    return client;
  }
  function adapter(client) {
    return { query: (sql, parameters) => client.query(sql, parameters), exec: (sql) => client.query(sql) };
  }
  async function configure(client) {
    await client.query('BEGIN');
    await client.query("SELECT set_config('powershift.owner_id',$1,true),set_config('powershift.confirmed','true',true)", [owner]);
    await client.query('SET LOCAL ROLE powershift_app');
  }
  async function seed() {
    await migrate(db, { migrations: loadMigrations(migrationDirectory) });
    owner = randomUUID(); profile = randomUUID();
    await db.query('INSERT INTO powershift.users(id,identity_issuer,identity_subject) VALUES($1,$2,$3)', [owner,'concurrency-test',randomUUID()]);
    await db.exec('BEGIN');
    await db.query("SELECT set_config('powershift.owner_id',$1,true),set_config('powershift.confirmed','true',true)", [owner]);
    await db.exec('SET LOCAL ROLE powershift_app');
    await db.query("INSERT INTO powershift.profiles(id,name,sector,currency,client_request_id,request_fingerprint) VALUES($1,'Concurrency test','home','NGN',$2,$3)", [profile,randomUUID(),fingerprint]);
    await db.exec('COMMIT');
  }
  function insertAppliance(client, { scanId = null, requestId = randomUUID() } = {}) {
    return client.query(`INSERT INTO powershift.appliances(profile_id,name,quantity,rated_watts,hours_per_day,effective_load_percent,source_method,scan_id,field_provenance,client_request_id,request_fingerprint)
      VALUES($1,'Fan',1,100,8,50,$2,$3,$4,$5,$6) RETURNING id, version::text`, [profile,scanId ? 'ai_label_extraction' : 'manual',scanId,provenance,requestId,fingerprint]);
  }
  async function waitForLock(client) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const activity = (await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [client.processID])).rows[0];
      if (activity?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Expected the second transaction to wait on a native PostgreSQL lock');
  }
  test('simultaneous migration invocations serialize and apply each migration once', async () => {
    const first = await connection();
    const second = await connection();
    const results = await Promise.all([migrate(adapter(first)), migrate(adapter(second))]);
    const versions = loadMigrations(migrationDirectory).map((item) => item.version);
    assert.deepEqual(results.map((result) => result.versions.length).sort((a,b)=>a-b), [0,versions.length]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift_meta.schema_migrations')).rows[0].n, versions.length);
  });
  test('two sessions cannot confirm one scan into two appliances', async () => {
    await seed();
    const first = await connection(); const second = await connection();
    await configure(first); await configure(second);
    const candidate = {name:'Fan',brand:null,model:null,watts:100,voltage:null,current:null,kwh_per_day:null,notes:'',visible_evidence:'100 W'};
    const scanId = randomUUID();
    await first.query("INSERT INTO powershift.scan_sessions(id,profile_id,status,candidate,consent_notice_version,consented_at,expires_at) VALUES($1,$2,'candidate',$3,'v1',now(),now()+interval '1 hour')", [scanId,profile,JSON.stringify(candidate)]);
    await first.query('COMMIT'); await configure(first);
    const saved = await insertAppliance(first, {scanId});
    const pending = insertAppliance(second, {scanId}).then(()=>({ok:true}), (error)=>({ok:false,code:error.code}));
    await waitForLock(second);
    await first.query('COMMIT');
    assert.deepEqual(await pending, {ok:false,code:'23514'});
    await second.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.appliances')).rows[0].n, 1);
    assert.equal((await db.query('SELECT confirmed_appliance_id FROM powershift.scan_sessions WHERE id=$1', [scanId])).rows[0].confirmed_appliance_id, saved.rows[0].id);
  });
  test('concurrent stale-version updates affect one row and return zero for the stale writer', async () => {
    await seed();
    const first = await connection(); const second = await connection();
    await configure(first);
    const id = (await insertAppliance(first)).rows[0].id;
    await first.query('COMMIT'); await configure(first); await configure(second);
    assert.equal((await first.query('SELECT version::text FROM powershift.appliances WHERE id=$1',[id])).rows[0].version,'1');
    assert.equal((await second.query('SELECT version::text FROM powershift.appliances WHERE id=$1',[id])).rows[0].version,'1');
    assert.equal((await first.query("UPDATE powershift.appliances SET name='First writer' WHERE id=$1 AND version=1 RETURNING id",[id])).rowCount,1);
    const pending = second.query("UPDATE powershift.appliances SET name='Stale writer' WHERE id=$1 AND version=1 RETURNING id",[id]);
    await waitForLock(second);
    await first.query('COMMIT');
    assert.equal((await pending).rowCount,0);
    await second.query('COMMIT');
    assert.deepEqual((await db.query('SELECT name,version::text FROM powershift.appliances WHERE id=$1',[id])).rows[0],{name:'First writer',version:'2'});
  });
  test('concurrent idempotency keys commit one resource and reject the duplicate atomically', async () => {
    await seed();
    const first = await connection(); const second = await connection();
    await configure(first); await configure(second);
    const requestId = randomUUID();
    const saved = await insertAppliance(first,{requestId});
    const pending = insertAppliance(second,{requestId}).then(()=>({ok:true}), (error)=>({ok:false,code:error.code}));
    await waitForLock(second);
    await first.query('COMMIT');
    assert.deepEqual(await pending,{ok:false,code:'23505'});
    await second.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.appliances')).rows[0].n,1);
    assert.deepEqual((await db.query("SELECT resource_id FROM powershift.request_keys WHERE operation='appliance.create'")).rows,[{resource_id:saved.rows[0].id}]);
  });
});

describe('PostgreSQL persistence domain', { concurrency: false }, () => {
  let db;
  let ids;
  let savepoint = 0;
  const fingerprint = 'a'.repeat(64);
  const provenance = () => Object.fromEntries(
    ['name', 'quantity', 'rated_watts', 'hours_per_day', 'effective_load_percent', 'brand', 'model']
      .map((field) => [field, { origin: 'user_entry', evidence: null }]),
  );
  before(async () => {
    db = await createTestDatabase();
    await migrate(db, { migrations: loadMigrations(migrationDirectory) });
  });
  after(async () => { await db.close(); });
  async function context(owner, confirmed = false) {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('powershift.owner_id', $1, true), set_config('powershift.confirmed', $2, true)", [owner || '', String(confirmed)]);
    await db.exec('SET LOCAL ROLE powershift_app');
  }
  async function insert(table, values) {
    const columns = Object.keys(values);
    assert.ok(columns.every((key) => /^[a-z_]+$/.test(key)));
    return (await db.query(`INSERT INTO powershift.${table} (${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`, columns.map((key) => values[key]))).rows[0];
  }
  async function appliance(overrides = {}) {
    return insert('appliances', {
      id: randomUUID(), owner_id: ids.ownerA, profile_id: ids.profileA,
      name: 'Fan', quantity: 1, rated_watts: '100', hours_per_day: '8',
      effective_load_percent: '50', source_method: 'manual',
      field_provenance: JSON.stringify(provenance()), client_request_id: randomUUID(),
      request_fingerprint: fingerprint, ...overrides,
    });
  }
  async function scan(overrides = {}) {
    const now = Date.now();
    return insert('scan_sessions', {
      id: randomUUID(), owner_id: ids.ownerA, profile_id: ids.profileA,
      status: 'candidate',
      candidate: JSON.stringify({ name: 'Fan', brand: null, model: null, watts: 100,
        voltage: null, current: null, kwh_per_day: null, notes: '', visible_evidence: '100 W' }),
      consent_notice_version: 'v1', consented_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 3600000).toISOString(), ...overrides,
    });
  }
  async function reportFixture(tariff = null) {
    // Hand-checked fixture: each eligible 100W * 8h * 50% appliance uses
    // 0.4 kWh/day and 12 kWh in 30 days. This helper is not application arithmetic.
    const appliances = (await db.query(`SELECT to_jsonb(a) - 'owner_id' - 'client_request_id' - 'request_fingerprint' AS snapshot FROM powershift.appliances a WHERE profile_id = $1 ORDER BY id`, [ids.profileA])).rows.map((row) => row.snapshot);
    const rows = appliances.map((item, index) => {
      const eligible = item.calculation_status === 'eligible';
      if (eligible) {
        assert.equal(Number(item.rated_watts), 100);
        assert.equal(Number(item.hours_per_day), 8);
        assert.equal(Number(item.effective_load_percent), 50);
        assert.equal(Number(item.quantity), 1);
      }
      item.calculated_daily_kwh = eligible ? '0.400000' : null;
      return { input_index: index, id: item.id, status: item.calculation_status,
        daily_kwh: item.calculated_daily_kwh, period_kwh: eligible ? '12.000000' : null,
        issues: eligible ? [] : ['rated_watts','hours_per_day','effective_load_percent'].filter((field)=>item[field]===null).map((field)=>({path:`/${field}`,code:'MISSING_VALUE',message:'This estimate input is unknown.'})) };
    });
    const eligible = rows.filter((row) => row.status === 'eligible').length;
    assert.ok(eligible <= 1, 'Use the hand-checked single-eligible-row fixture');
    const rate = tariff === null ? null : Number(tariff.rate_ngn_per_kwh);
    assert.ok(rate === null || rate === 0 || rate === 100);
    const tariffProvenance = tariff === null ? null : 'user_input';
    const incomplete = rows.length - eligible;
    const warnings = [];
    if (incomplete) warnings.push({code:'INCOMPLETE_RECORDS',message:`${incomplete} incomplete record(s) were excluded from totals.`});
    if (!eligible) warnings.push({code:'NO_ELIGIBLE_RECORDS',message:'No complete confirmed records are available for an estimate.'});
    warnings.push({code:'RATED_POWER_ESTIMATE',message:'Rated power can differ from average operating draw.'});
    const calculation = {
      contract_version: '0.1.0', estimate: true, period_days: 30,
      rate_ngn_per_kwh: rate, tariff_provenance: tariffProvenance, rows,
      counts: { total: rows.length, eligible, incomplete, invalid: 0, unconfirmed: 0 },
      totals: { daily_kwh: eligible ? '0.400000' : null, period_kwh: eligible ? '12.000000' : null,
        grid_equivalent_cost_ngn: !eligible || rate === null ? null : rate === 0 ? '0.00' : '1200.00' },
      warnings,
      assumptions: [
        'Energy is estimated from customer-provided ratings and usage, not measured by a meter.',
        'Rated watts may differ from average operating draw.',
        'Each eligible row uses the explicitly supplied effective-load percentage; unknown values are never defaulted.',
        `${eligible} eligible record(s) contribute; ${incomplete} record(s) are excluded.`,
        'Exact decimal-input arithmetic precedes round-half-up presentation: energy has six decimal places and NGN has two.',
        rate === null ? 'No tariff was supplied, so no cost estimate is shown.' : 'Cost is a hypothetical all-grid estimate using a customer-entered tariff, not an actual mixed-source bill or savings claim.',
      ],
    };
    const inputSnapshot = { appliances, period_days: 30, rate_ngn_per_kwh: rate, tariff_provenance: tariffProvenance };
    return { owner_id: ids.ownerA, profile_id: ids.profileA, tariff_input_id: tariff?.id || null, period_days: 30,
      contract_version: '0.1.0', input_snapshot: JSON.stringify(inputSnapshot), calculation: JSON.stringify(calculation),
      client_request_id: randomUUID(), request_fingerprint: fingerprint };
  }
  async function expectSqlstate(action, code) {
    const name = `expected_error_${++savepoint}`;
    await db.exec(`SAVEPOINT ${name}`);
    try {
      await assert.rejects(action, (error) => {
        assert.equal(error.code, code, error.message);
        return true;
      });
    } finally {
      await db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
    }
  }
  beforeEach(async (testContext) => {
    ids = Object.fromEntries(['ownerA', 'ownerB', 'profileA', 'profileA2', 'profileB'].map((key) => [key, randomUUID()]));
    await db.exec(testContext.name === 'report creation rejects a read-committed transaction'
      ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query('INSERT INTO powershift.users(id, identity_issuer, identity_subject) VALUES ($1, $2, $3), ($4, $2, $5)', [ids.ownerA, 'test-issuer', randomUUID(), ids.ownerB, randomUUID()]);
    for (const [owner, profile] of [[ids.ownerA, ids.profileA], [ids.ownerA, ids.profileA2], [ids.ownerB, ids.profileB]]) {
      await db.query("SELECT set_config('powershift.owner_id', $1, true)", [owner]);
      await insert('profiles', { id: profile, owner_id: owner, name: 'Private test profile', sector: 'home', currency: 'NGN', client_request_id: randomUUID(), request_fingerprint: fingerprint });
    }
    await context(ids.ownerA, true);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  test('all nine domain tables force RLS and the application role cannot bypass it', async () => {
    const tables = (await db.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace WHERE n.nspname = 'powershift' AND relkind = 'r'")).rows;
    assert.equal(tables.length, 9);
    assert.ok(tables.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    const role = (await db.query("SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'powershift_app'")).rows[0];
    assert.ok(Object.values(role).every((value) => value === false));
    await expectSqlstate(() => db.query('SELECT * FROM powershift_meta.schema_migrations'), '42501');
  });
  test('owner context scopes users, profiles, appliances, scans and audit records', async () => {
    const saved = await appliance();
    await scan();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.users')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.profiles')).rows[0].n, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.appliances')).rows[0].n, 1);
    await context(ids.ownerB, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.appliances')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.scan_sessions')).rows[0].n, 0);
    assert.ok((await db.query('SELECT DISTINCT owner_id FROM powershift.audit_events')).rows.every((row) => row.owner_id === ids.ownerB));
    assert.equal((await db.query('UPDATE powershift.appliances SET name = $2 WHERE id = $1 RETURNING id', [saved.id, 'Intrusion'])).rows.length, 0);
    assert.equal((await db.query('DELETE FROM powershift.appliances WHERE id = $1 RETURNING id', [saved.id])).rows.length, 0);
    await expectSqlstate(() => appliance({ owner_id: ids.ownerA }), '42501');
  });
  test('missing owner context returns no private records and refuses writes', async () => {
    await context(null, true);
    for (const table of ['users', 'profiles', 'appliances', 'scan_sessions', 'reports', 'tariff_inputs', 'energy_records', 'audit_events', 'request_keys']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM powershift.${table}`)).rows[0].n, 0, table);
    }
    await expectSqlstate(() => appliance(), '42501');
  });
  test('composite foreign keys prevent a same-owner appliance attaching to another owner profile', async () => {
    await expectSqlstate(() => appliance({ profile_id: ids.profileB }), '23503');
  });
  for (const field of ['rated_watts', 'hours_per_day', 'effective_load_percent']) {
    test(`unknown ${field} is preserved as null and the saved row is incomplete`, async () => {
      const saved = await appliance({ [field]: null, ...(field === 'hours_per_day' ? {} : { hours_per_day: '0' }) });
      assert.equal(saved[field], null);
      assert.equal(saved.calculation_status, 'incomplete');
    });
  }
  test('zero hours and exact long decimals remain eligible without rounding', async () => {
    const saved = await appliance({ rated_watts: '0.12345678901234567890123456789', hours_per_day: '0', effective_load_percent: '100', quantity: '9007199254740991' });
    assert.equal(saved.calculation_status, 'eligible');
    const row = (await db.query('SELECT rated_watts::text, hours_per_day::text, quantity::text FROM powershift.appliances WHERE id = $1', [saved.id])).rows[0];
    assert.equal(row.rated_watts, '0.12345678901234567890123456789');
    assert.equal(row.hours_per_day, '0');
    assert.equal(row.quantity, '9007199254740991');
  });
  for (const [field, value] of [
    ['quantity', 0], ['quantity', -1], ['quantity', '9007199254740992'],
    ['rated_watts', '0'], ['rated_watts', '-1'], ['rated_watts', 'NaN'], ['rated_watts', 'Infinity'], ['rated_watts', '-Infinity'],
    ['hours_per_day', '-0.01'], ['hours_per_day', '24.01'], ['hours_per_day', 'NaN'],
    ['effective_load_percent', '0'], ['effective_load_percent', '100.01'], ['effective_load_percent', 'Infinity'],
    ['name', ''], ['name', ' padded '], ['request_fingerprint', 'invalid'],
  ]) {
    test(`appliance constraint refuses ${field}=${value}`, async () => {
      await expectSqlstate(() => appliance({ [field]: value }), '23514');
    });
  }
  test('explicit customer confirmation is required on creates and corrections', async () => {
    await context(ids.ownerA, false);
    await expectSqlstate(() => appliance(), '23514');
    await context(ids.ownerA, true);
    const saved = await appliance();
    await context(ids.ownerA, false);
    await expectSqlstate(() => db.query('UPDATE powershift.appliances SET name = $2 WHERE id = $1', [saved.id, 'Changed']), '23514');
  });
  test('provenance must have seven known fields and usage assumptions cannot claim label extraction', async () => {
    await expectSqlstate(() => appliance({ field_provenance: '{}' }), '23514');
    const usage = provenance();
    usage.hours_per_day.origin = 'label_extraction';
    await expectSqlstate(() => appliance({ field_provenance: JSON.stringify(usage) }), '23514');
    const falseLabel = provenance();
    falseLabel.rated_watts.origin = 'label_extraction';
    await expectSqlstate(() => appliance({ field_provenance: JSON.stringify(falseLabel) }), '23514');
  });
  test('document provenance applies to the rating and cannot claim manual or usage origins', async () => {
    const values = provenance();
    values.rated_watts = { origin: 'document', evidence: 'Customer product manual' };
    await appliance({ source_method: 'document', field_provenance: JSON.stringify(values) });
    await expectSqlstate(() => appliance({ field_provenance: JSON.stringify(values) }), '23514');
    values.brand.origin = 'document';
    await expectSqlstate(() => appliance({ source_method: 'document', field_provenance: JSON.stringify(values) }), '23514');
    values.brand.origin = 'user_entry';
    values.effective_load_percent.origin = 'document';
    await expectSqlstate(() => appliance({ source_method: 'document', field_provenance: JSON.stringify(values) }), '23514');
  });
  test('optimistic updates increment versions and stale version filters change no rows', async () => {
    const saved = await appliance();
    const result = await db.query('UPDATE powershift.appliances SET name = $3 WHERE id = $1 AND version = $2 RETURNING version::text', [saved.id, '1', 'Corrected fan']);
    assert.equal(result.rows[0].version, '2');
    assert.equal((await db.query('UPDATE powershift.appliances SET name = $3 WHERE id = $1 AND version = $2 RETURNING id', [saved.id, '1', 'Stale edit'])).rows.length, 0);
    await expectSqlstate(() => db.query('UPDATE powershift.appliances SET version = 44 WHERE id = $1', [saved.id]), '23514');
    await expectSqlstate(() => db.query('UPDATE powershift.appliances SET profile_id = $2 WHERE id = $1', [saved.id, ids.profileA2]), '23514');
    await expectSqlstate(() => db.query('UPDATE powershift.appliances SET owner_id = $2 WHERE id = $1', [saved.id, ids.ownerB]), '23514');
    const profile = (await db.query('UPDATE powershift.profiles SET name = $2 WHERE id = $1 RETURNING version::text', [ids.profileA, 'New profile name'])).rows[0];
    assert.equal(profile.version, '2');
  });
  test('valid scan confirmation is atomic, consumed once and permits later corrections', async () => {
    const receipt = await scan();
    const values = provenance();
    values.rated_watts = { origin: 'label_extraction', evidence: '100 W' };
    const saved = await appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id, field_provenance: JSON.stringify(values) });
    const confirmed = (await db.query('SELECT status, confirmed_appliance_id, version::text FROM powershift.scan_sessions WHERE id = $1', [receipt.id])).rows[0];
    assert.deepEqual(confirmed, { status: 'confirmed', confirmed_appliance_id: saved.id, version: '2' });
    await expectSqlstate(() => appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id }), '23514');
    values.rated_watts = { origin: 'user_correction', evidence: 'Customer correction' };
    await db.query('UPDATE powershift.appliances SET rated_watts = 120, field_provenance = $2 WHERE id = $1', [saved.id, JSON.stringify(values)]);
    assert.equal((await db.query('SELECT rated_watts::text FROM powershift.appliances WHERE id = $1', [saved.id])).rows[0].rated_watts, '120');
  });
  test('deleting a confirmed appliance preserves the consumed scan tombstone and request key', async () => {
    const receipt = await scan();
    const saved = await appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id });
    await db.query('DELETE FROM powershift.appliances WHERE id = $1', [saved.id]);
    assert.equal((await db.query('SELECT confirmed_appliance_id FROM powershift.scan_sessions WHERE id = $1', [receipt.id])).rows[0].confirmed_appliance_id, saved.id);
    assert.equal((await db.query("SELECT resource_id FROM powershift.request_keys WHERE operation = 'appliance.create' AND resource_id = $1", [saved.id])).rows[0].resource_id, saved.id);
    await expectSqlstate(() => appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id }), '23514');
    await expectSqlstate(() => appliance({ client_request_id: saved.client_request_id }), '23505');
  });
  test('expired, wrong-profile and falsely extracted scan values are refused', async () => {
    const now = Date.now();
    const expired = await scan({ created_at: new Date(now - 7200000).toISOString(), consented_at: new Date(now - 7200000).toISOString(), expires_at: new Date(now - 3600000).toISOString() });
    await expectSqlstate(() => appliance({ source_method: 'ai_label_extraction', scan_id: expired.id }), '23514');
    const otherProfile = await scan({ profile_id: ids.profileA2 });
    await expectSqlstate(() => appliance({ source_method: 'ai_label_extraction', scan_id: otherProfile.id }), '23503');
    const receipt = await scan();
    const values = provenance();
    values.rated_watts.origin = 'label_extraction';
    await expectSqlstate(() => appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id, rated_watts: '120', field_provenance: JSON.stringify(values) }), '23514');
    assert.equal((await db.query('SELECT status FROM powershift.scan_sessions WHERE id = $1', [receipt.id])).rows[0].status, 'candidate');
  });
  test('scan state and candidate shape reject impossible and non-finite evidence', async () => {
    await expectSqlstate(() => scan({ status: 'pending' }), '23514');
    await expectSqlstate(() => scan({ candidate: '{}' }), '23514');
    await expectSqlstate(() => scan({ expires_at: 'infinity' }), '23514');
    const receipt = await scan();
    const malformed = { ...receipt.candidate, watts: '100' };
    await expectSqlstate(() => scan({ candidate: JSON.stringify(malformed) }), '23514');
    await expectSqlstate(() => db.query("UPDATE powershift.scan_sessions SET candidate = $2 WHERE id = $1", [receipt.id, JSON.stringify({...receipt.candidate, watts:120})]), '23514');
  });
  test('scan confirmation cannot be performed directly and rejected writes roll consumption back', async () => {
    const receipt = await scan();
    await expectSqlstate(() => db.query("UPDATE powershift.scan_sessions SET status = 'confirmed', confirmed_appliance_id = $2, confirmed_at = now() WHERE id = $1", [receipt.id, randomUUID()]), '23514');
    await db.exec('SAVEPOINT confirmation_rollback');
    await appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id });
    await db.exec('ROLLBACK TO SAVEPOINT confirmation_rollback; RELEASE SAVEPOINT confirmation_rollback');
    assert.equal((await db.query('SELECT status FROM powershift.scan_sessions WHERE id = $1', [receipt.id])).rows[0].status, 'candidate');
    await appliance({ source_method: 'ai_label_extraction', scan_id: receipt.id });
  });
  test('audit is append-only to the app, contains metadata only and rolls back with writes', async () => {
    const saved = await appliance({ source_notes: 'SENSITIVE_INPUT_SENTINEL' });
    await db.query('UPDATE powershift.appliances SET name = $2 WHERE id = $1', [saved.id, 'SENSITIVE_NAME_SENTINEL']);
    const events = (await db.query("SELECT * FROM powershift.audit_events WHERE entity_type = 'appliances' AND resource_id = $1 ORDER BY id", [saved.id])).rows;
    assert.deepEqual(events.map((row) => row.action), ['created', 'updated']);
    assert.ok(!JSON.stringify(events).includes('SENSITIVE_'));
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'powershift' AND table_name = 'audit_events' ORDER BY ordinal_position")).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['id', 'owner_id', 'actor_id', 'profile_id', 'entity_type', 'resource_id', 'action', 'resource_version', 'request_id', 'occurred_at']);
    await expectSqlstate(() => db.query('DELETE FROM powershift.audit_events WHERE resource_id = $1', [saved.id]), '42501');
    await expectSqlstate(() => db.query('UPDATE powershift.audit_events SET action = $2 WHERE resource_id = $1', [saved.id, 'deleted']), '42501');
    const countBefore = (await db.query('SELECT count(*)::int AS n FROM powershift.audit_events')).rows[0].n;
    const keysBefore = (await db.query('SELECT count(*)::int AS n FROM powershift.request_keys')).rows[0].n;
    await db.exec('SAVEPOINT audit_rollback');
    await appliance();
    await db.exec('ROLLBACK TO SAVEPOINT audit_rollback; RELEASE SAVEPOINT audit_rollback');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.audit_events')).rows[0].n, countBefore);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.request_keys')).rows[0].n, keysBefore);
  });
  test('request-key ledger scopes owner, operation and profile and refuses direct app writes', async () => {
    const requestId = randomUUID();
    const first = await appliance({ client_request_id: requestId });
    await expectSqlstate(() => appliance({ client_request_id: requestId }), '23505');
    const second = await appliance({ profile_id: ids.profileA2, client_request_id: requestId });
    assert.notEqual(first.id, second.id);
    const keys = (await db.query("SELECT profile_id, resource_id FROM powershift.request_keys WHERE operation = 'appliance.create' AND client_request_id = $1 ORDER BY profile_id", [requestId])).rows;
    assert.equal(keys.length, 2);
    await expectSqlstate(() => db.query('DELETE FROM powershift.request_keys WHERE client_request_id = $1', [requestId]), '42501');
    await expectSqlstate(() => db.query("INSERT INTO powershift.request_keys(owner_id,operation,profile_id,client_request_id,request_fingerprint,resource_id) VALUES ($1,'appliance.create',$2,$3,$4,$5)", [ids.ownerA, ids.profileA, randomUUID(), fingerprint, randomUUID()]), '42501');
    await expectSqlstate(() => db.query('INSERT INTO powershift.users(identity_issuer,identity_subject) VALUES ($1,$2)', ['injected', randomUUID()]), '42501');
  });
  test('tariffs accept zero and exact decimals while invalid rates and periods fail', async () => {
    const values = { owner_id: ids.ownerA, profile_id: ids.profileA, rate_ngn_per_kwh: '0', period_days: 366, provenance: 'user_input' };
    const tariff = await insert('tariff_inputs', values);
    assert.equal((await db.query('SELECT rate_ngn_per_kwh::text FROM powershift.tariff_inputs WHERE id = $1', [tariff.id])).rows[0].rate_ngn_per_kwh, '0');
    for (const change of [{ rate_ngn_per_kwh: '-1' }, { rate_ngn_per_kwh: 'NaN' }, { rate_ngn_per_kwh: 'Infinity' }, { period_days: 0 }, { period_days: 367 }, { provenance: 'inferred' }]) {
      await expectSqlstate(() => insert('tariff_inputs', { ...values, ...change }), '23514');
    }
    await expectSqlstate(() => db.query('UPDATE powershift.tariff_inputs SET rate_ngn_per_kwh = 12 WHERE id = $1', [tariff.id]), '42501');
  });
  test('measured energy stays distinct, validates intervals and survives appliance deletion', async () => {
    const saved = await appliance();
    const values = { owner_id: ids.ownerA, profile_id: ids.profileA, appliance_id: saved.id, energy_kwh: '0.1234567890123456789', observed_from: '2026-10-01T00:00:00Z', observed_to: '2026-10-02T00:00:00Z', source_method: 'measured', source_notes: 'Meter reading supplied by customer' };
    const energy = await insert('energy_records', values);
    assert.equal((await db.query('SELECT energy_kwh::text FROM powershift.energy_records WHERE id = $1', [energy.id])).rows[0].energy_kwh, '0.1234567890123456789');
    for (const change of [{ energy_kwh: '-1' }, { energy_kwh: 'NaN' }, { observed_to: values.observed_from }, { source_method: 'estimated' }, { observed_to: 'infinity' }, { observed_from: '-infinity' }]) {
      await expectSqlstate(() => insert('energy_records', { ...values, ...change }), '23514');
    }
    await expectSqlstate(() => insert('energy_records', { ...values, profile_id: ids.profileA2 }), '23503');
    await db.query('DELETE FROM powershift.appliances WHERE id = $1', [saved.id]);
    const afterDelete = (await db.query('SELECT appliance_id, energy_kwh::text FROM powershift.energy_records WHERE id = $1', [energy.id])).rows[0];
    assert.deepEqual(afterDelete, { appliance_id: null, energy_kwh: '0.1234567890123456789' });
    await expectSqlstate(() => db.query('UPDATE powershift.energy_records SET energy_kwh = 1 WHERE id = $1', [energy.id]), '42501');
  });
  test('report snapshot and calculation history survive appliance edits and deletion', async () => {
    const saved = await appliance();
    const fixture = await reportFixture();
    const report = await insert('reports', fixture);
    await expectSqlstate(() => insert('reports', fixture), '23505');
    await db.query('UPDATE powershift.appliances SET name = $2, rated_watts = 120 WHERE id = $1', [saved.id, 'Edited after report']);
    await db.query('DELETE FROM powershift.appliances WHERE id = $1', [saved.id]);
    const history = (await db.query('SELECT input_snapshot, calculation FROM powershift.reports WHERE id = $1', [report.id])).rows[0];
    assert.deepEqual(history.input_snapshot, JSON.parse(fixture.input_snapshot));
    assert.deepEqual(history.calculation, JSON.parse(fixture.calculation));
    assert.equal(history.input_snapshot.appliances[0].name, 'Fan');
    await expectSqlstate(() => db.query('UPDATE powershift.reports SET calculation = $2 WHERE id = $1', [report.id, '{}']), '42501');
    await expectSqlstate(() => db.query('DELETE FROM powershift.reports WHERE id = $1', [report.id]), '42501');
    await db.exec('RESET ROLE');
    await expectSqlstate(() => db.query('UPDATE powershift.reports SET calculation = $2 WHERE id = $1', [report.id, '{}']), '23514');
  });
  test('reports preserve incomplete records, empty totals, zero tariff and tariff ownership', async () => {
    await appliance({ effective_load_percent: null });
    let report = await insert('reports', await reportFixture());
    assert.equal(report.calculation.counts.incomplete, 1);
    assert.equal(report.calculation.totals.daily_kwh, null);
    const tariff = await insert('tariff_inputs', { owner_id: ids.ownerA, profile_id: ids.profileA, rate_ngn_per_kwh: '0', period_days: 30, provenance: 'user_input' });
    report = await insert('reports', await reportFixture(tariff));
    assert.equal(report.calculation.rate_ngn_per_kwh, 0);
    assert.equal(report.calculation.tariff_provenance, 'user_input');
    assert.equal(report.calculation.totals.grid_equivalent_cost_ngn, null);
    await db.query('DELETE FROM powershift.appliances WHERE profile_id = $1', [ids.profileA]);
    report = await insert('reports', await reportFixture());
    assert.equal(report.calculation.counts.total, 0);
    assert.equal(report.input_snapshot.appliances.length, 0);
    await appliance();
    report = await insert('reports', await reportFixture(tariff));
    assert.equal(report.calculation.totals.grid_equivalent_cost_ngn, '0.00');
    const foreignTariff = await insert('tariff_inputs', { owner_id: ids.ownerA, profile_id: ids.profileA2, rate_ngn_per_kwh: '0', period_days: 30, provenance: 'user_input' });
    await expectSqlstate(async () => insert('reports', await reportFixture(foreignTariff)), '23514');
    await context(ids.ownerB, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.reports')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.tariff_inputs')).rows[0].n, 0);
  });
  test('report creation rejects a read-committed transaction', async () => {
    assert.equal((await db.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed');
    await expectSqlstate(async () => insert('reports', await reportFixture()), '23514');
  });
  test('incomplete report rows require structured missing-value issues and exclusion warnings', async () => {
    await appliance({ rated_watts: null });
    const fixture = await reportFixture();
    const malformedIssues = JSON.parse(fixture.calculation);
    malformedIssues.rows[0].issues = [123];
    await expectSqlstate(() => insert('reports', { ...fixture, calculation: JSON.stringify(malformedIssues) }), '23514');
    const missingExclusion = JSON.parse(fixture.calculation);
    missingExclusion.warnings = missingExclusion.warnings.filter((warning) => warning.code !== 'INCOMPLETE_RECORDS');
    await expectSqlstate(() => insert('reports', { ...fixture, calculation: JSON.stringify(missingExclusion) }), '23514');
    const missingEmpty = JSON.parse(fixture.calculation);
    missingEmpty.warnings = missingEmpty.warnings.filter((warning) => warning.code !== 'NO_ELIGIBLE_RECORDS');
    await expectSqlstate(() => insert('reports', { ...fixture, calculation: JSON.stringify(missingEmpty) }), '23514');
  });
  for (const [label, mutate] of [
    ['invalid shape', (snap) => { delete snap.appliances; }],
    ['omitted stored records', (snap, calc) => { snap.appliances = []; calc.rows = []; }],
    ['stale snapshot version', (snap) => { snap.appliances[0].version = 99; }],
    ['changed snapshot input', (snap) => { snap.appliances[0].rated_watts = 120; }],
    ['false source timestamp', (snap) => { snap.appliances[0].confirmed_at = '2020-01-01T00:00:00Z'; }],
    ['row identity mismatch', (snap, calc) => { calc.rows[0].id = randomUUID(); }],
    ['eligible row with missing energy', (snap, calc) => { calc.rows[0].period_kwh = null; }],
    ['bad fixed-point format', (snap, calc) => { calc.totals.daily_kwh = '0.4'; }],
    ['false estimate assertion', (snap, calc) => { calc.estimate = false; }],
    ['inconsistent counts', (snap, calc) => { calc.counts.eligible = 2; }],
    ['missing assumptions', (snap, calc) => { calc.assumptions = []; }],
    ['cost without tariff', (snap, calc) => { calc.totals.grid_equivalent_cost_ngn = '12.00'; }],
    ['unbacked tariff', (snap, calc) => { snap.rate_ngn_per_kwh = calc.rate_ngn_per_kwh = 100; snap.tariff_provenance = calc.tariff_provenance = 'user_input'; }],
    ['numeric string snapshot period', (snap) => { snap.period_days = '30'; }],
    ['numeric string calculation period', (snap, calc) => { calc.period_days = '30'; }],
    ['numeric string input index', (snap, calc) => { calc.rows[0].input_index = '0'; }],
    ['malformed warnings', (snap, calc) => { calc.warnings = [123]; }],
    ['missing rated-power warning', (snap, calc) => { calc.warnings = []; }],
  ]) {
    test(`report contract refuses ${label}`, async () => {
      await appliance();
      const fixture = await reportFixture();
      const snap = JSON.parse(fixture.input_snapshot);
      const calc = JSON.parse(fixture.calculation);
      mutate(snap, calc);
      await expectSqlstate(() => insert('reports', { ...fixture, input_snapshot: JSON.stringify(snap), calculation: JSON.stringify(calc) }), '23514');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM powershift.reports')).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM powershift.request_keys WHERE operation = 'report.create'")).rows[0].n, 0);
    });
  }
});
