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
});
