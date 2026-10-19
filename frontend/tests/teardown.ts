import { readFileSync } from 'node:fs';
export default async function teardown() {
  try {
    const session = JSON.parse(readFileSync(process.env.POWERSHIFT_BROWSER_SESSION_FILE!, 'utf8'));
    await fetch('http://127.0.0.1:8787/__test/shutdown', { method: 'POST', headers: { 'X-Test-Stop': session.stopKey } });
  } catch { /* The isolated container is removed by its operator even after a failed launch. */ }
}
