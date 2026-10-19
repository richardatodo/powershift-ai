import type { LosslessNumber } from 'lossless-json';

export type Numeric = LosslessNumber;
export type Sector = 'home' | 'restaurant' | 'salon' | 'laundry' | 'retail' | 'office' | 'hotel' | 'workshop';
export interface Profile { id: string; name: string | null; sector: Sector; currency: 'NGN'; version: Numeric; }
export interface Appliance {
  id: string; profile_id: string; name: string; quantity: Numeric;
  rated_watts: Numeric | null; hours_per_day: Numeric | null; effective_load_percent: Numeric | null;
  brand: string | null; model: string | null; source_method: 'manual' | 'document' | 'ai_label_extraction';
  source_notes: string | null; scan_id: string | null; source_status: 'customer_confirmed';
  version: Numeric; calculation_status: 'eligible' | 'incomplete'; calculated_daily_kwh: string | null;
}
export interface Workspace { profile: Profile; appliances: Appliance[]; }
export interface ProfilePage { profiles: Profile[]; next_cursor: string | null; }
export interface ScanNotice { version: string; text: string; maxImageBytes: Numeric; timeoutSeconds: Numeric; }
export interface ScanResponse {
  scan_id: string; profile_id: string; expires_at: string; requiresConfirmation: true;
  result: { name: string | null; brand: string | null; model: string | null; watts: Numeric | null;
    voltage: string | null; current: string | null; kwh_per_day: Numeric | null; notes: string; visible_evidence: string; };
}
export interface Assessment {
  period_days: Numeric; rate_ngn_per_kwh: Numeric | null; tariff_provenance: 'user_input' | null;
  counts: { total: Numeric; eligible: Numeric; incomplete: Numeric; invalid: Numeric; unconfirmed: Numeric };
  totals: { daily_kwh: string | null; period_kwh: string | null; grid_equivalent_cost_ngn: string | null };
  rows: { id: string; status: string; daily_kwh: string | null; period_kwh: string | null; issues: { path: string; code: string; message: string }[] }[];
  warnings: { code: string; message: string }[]; assumptions: string[];
}
export interface EnergyReport {
  id: string; profile_id: string; created_at: string;
  input_snapshot: { appliances: Appliance[]; period_days: Numeric; rate_ngn_per_kwh: Numeric | null; tariff_provenance: 'user_input' | null };
  calculation: Assessment;
}
export const sectors: { value: Sector; label: string }[] = [
  { value: 'home', label: 'Home' }, { value: 'restaurant', label: 'Restaurant or café' },
  { value: 'salon', label: 'Salon or barbershop' }, { value: 'laundry', label: 'Laundry' },
  { value: 'retail', label: 'Retail or supermarket' }, { value: 'office', label: 'Office' },
  { value: 'hotel', label: 'Hotel or guesthouse' }, { value: 'workshop', label: 'Workshop' },
];
export function text(value: Numeric | string | number | null | undefined) { return value == null ? '' : String(value); }
export function energy(value: string | null | undefined) { return value == null ? '—' : value.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'); }
