import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from './api';

afterEach(() => vi.unstubAllGlobals());
describe('session failure boundary', () => {
  it('clears private state on a non-JSON 401 from an upstream proxy', async () => {
    const expired = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    const api = new Api(async () => 'ephemeral-test-token', expired);
    await expect(api.profiles()).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledOnce();
  });
  it('uses no cookies or cached authenticated responses', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"profiles":[],"next_cursor":null}'));
    vi.stubGlobal('fetch', request);
    await new Api(async () => 'ephemeral-test-token', vi.fn()).profiles();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
  });
  it('downloads CSV with bearer authentication and preserves raw cells', async () => {
    const csv = 'name,daily_kwh\r\n"Fan, room",0.123457\r\n';
    const request = vi.fn(async () => new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8'}}));
    vi.stubGlobal('fetch',request);
    const blob = await new Api(async () => 'ephemeral-test-token',vi.fn()).reportCsv('saved-id');
    expect(await blob.text()).toBe(csv);
    expect(request).toHaveBeenCalledWith('/api/reports/saved-id/export.csv',expect.objectContaining({
      headers: {Authorization:'Bearer ephemeral-test-token'},credentials:'omit',cache:'no-store'}));
  });
  it('rejects a successful HTML page instead of downloading it as CSV', async () => {
    vi.stubGlobal('fetch',vi.fn(async () => new Response('<html>Proxy error</html>',{headers:{'Content-Type':'text/html'}})));
    await expect(new Api(async () => 'ephemeral-test-token',vi.fn()).reportCsv('saved-id')).rejects.toMatchObject({code:'SERVICE_ERROR'});
  });
  it('clears the private report session when CSV download gets a non-JSON 401', async () => {
    const expired=vi.fn();vi.stubGlobal('fetch',vi.fn(async () => new Response('Unauthorized',{status:401})));
    await expect(new Api(async () => 'ephemeral-test-token',expired).reportCsv('saved-id')).rejects.toMatchObject({status:401});
    expect(expired).toHaveBeenCalledOnce();
  });
});
