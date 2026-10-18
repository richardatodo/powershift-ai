'use strict';

// Deployment/admin tooling. Application startup never runs migrations.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { migrate } = require('./migrate.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--down', '--allow-destructive-down'].includes(arg))
      || (args.includes('--down') && !args.includes('--allow-destructive-down'))) {
    throw new Error('Usage: migrate-postgres.cjs [--down --allow-destructive-down]');
  }
  const root = process.env.POWERSHIFT_PG_ROOT;
  const url = process.env.POWERSHIFT_MIGRATION_DATABASE_URL;
  if (!root || !url) throw new Error('Set POWERSHIFT_PG_ROOT and POWERSHIFT_MIGRATION_DATABASE_URL');
  const entry = require.resolve('pg', { paths: [root] });
  const manifest = path.resolve(path.dirname(entry), '../package.json');
  if (JSON.parse(readFileSync(manifest, 'utf8')).version !== '8.16.3') throw new Error('Use pinned pg@8.16.3');
  const { Client } = require(entry);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await migrate({ query: (sql, values) => client.query(sql, values),
                                  exec: (sql) => client.query(sql) },
                                 { direction: args.includes('--down') ? 'down' : 'up' });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await client.end();
  }
}

main().catch(() => {
  // Do not expose connection URLs, credentials, SQL parameters or server messages.
  process.stderr.write('Migration failed. Check configuration and schema history using an administrative connection.\n');
  process.exitCode = 1;
});
