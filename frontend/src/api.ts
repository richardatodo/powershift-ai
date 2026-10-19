import { parse, stringify, LosslessNumber } from 'lossless-json';
import type { Appliance, Assessment, EnergyReport, Profile, ProfilePage, ScanNotice, ScanResponse, Workspace } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: {path: string; message: string}[] = [], public requestId = '') { super(message); }
}
export class Api {
  constructor(private token: () => Promise<string>, private expired: () => void) {}
  private async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; timeout?: number; csv?: boolean } = {}): Promise<T> {
    const token = await this.token();
    if (!token) { this.expired(); throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Your session has ended. Sign in again.'); }
    let response: Response;
    try {
      response = await fetch('/api' + path, { method: options.method || 'GET', cache: 'no-store',
        credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout || 20000)]) : AbortSignal.timeout(options.timeout || 20000),
        headers: { Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: options.body === undefined ? undefined : stringify(options.body) });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiError(0, 'NETWORK_ERROR', 'We could not confirm the request. Check your connection, then retry without changing the form.');
    }
    if (response.status === 204) return undefined as T;
    if (response.status === 401) this.expired();
    if (options.csv && response.ok) {
      if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'text/csv') {
        throw new ApiError(502, 'SERVICE_ERROR', 'The service did not return a CSV file. Please try again.');
      }
      return await response.blob() as T;
    }
    let body: Record<string, unknown>;
    try { body = parse(await response.text()) as Record<string, unknown>; }
    catch { throw new ApiError(response.status || 502, 'SERVICE_ERROR', 'The service returned an unreadable response. Please try again.'); }
    if (!response.ok) {
      const error = body?.error as { code: string; message: string; details: {path: string; message: string}[]; request_id: string } | undefined;
      throw new ApiError(response.status, error?.code || 'SERVICE_ERROR', error?.message || 'The request could not be completed.', error?.details || [], error?.request_id);
    }
    return body as T;
  }
  profiles(after?: string, signal?: AbortSignal) { return this.request<ProfilePage>('/profiles' + (after ? '?after=' + encodeURIComponent(after) : ''), { signal }); }
  scanStatus(signal?: AbortSignal) { return this.request<{imageScanningConfigured: boolean; scanNotice?: ScanNotice}>('/status', { signal }); }
  scan(body: unknown, timeout: number, signal?: AbortSignal) { return this.request<ScanResponse>('/scan', { method: 'POST', body, timeout, signal }); }
  profile(id: string, signal?: AbortSignal) { return this.request<Workspace>('/profiles/' + encodeURIComponent(id), { signal }); }
  createProfile(body: unknown) { return this.request<Profile>('/profiles', { method: 'POST', body }); }
  saveAppliance(profileId: string, body: unknown, original?: Appliance) {
    return this.request<Appliance>(original ? '/appliances/' + original.id : '/profiles/' + profileId + '/appliances', { method: original ? 'PATCH' : 'POST', body });
  }
  remove(row: Appliance) { return this.request<void>(`/appliances/${row.id}?version=${encodeURIComponent(String(row.version))}`, { method: 'DELETE' }); }
  report(id: string, signal?: AbortSignal) { return this.request<EnergyReport>('/reports/' + encodeURIComponent(id), { signal }); }
  reportCsv(id: string, signal?: AbortSignal) { return this.request<Blob>('/reports/' + encodeURIComponent(id) + '/export.csv', { csv: true, signal }); }
  createReport(profileId: string, days: string, tariff: string, requestId: string, signal?: AbortSignal) {
    return this.request<EnergyReport>('/reports', { method: 'POST', signal, body: {
      profile_id: profileId, period_days: new LosslessNumber(days),
      rate_ngn_per_kwh: tariff === '' ? null : new LosslessNumber(tariff), client_request_id: requestId,
    } });
  }
  calculate(rows: Appliance[], days: string, tariff: string, signal?: AbortSignal) {
    return this.request<Assessment>('/calculations', { method: 'POST', signal, body: {
      appliances: rows.map(({ id, name, quantity, rated_watts, hours_per_day, effective_load_percent, source_status }) =>
        ({ id, name, quantity, rated_watts, hours_per_day, effective_load_percent, source_status })),
      period_days: new LosslessNumber(days), rate_ngn_per_kwh: tariff === '' ? null : new LosslessNumber(tariff),
    } });
  }
}
