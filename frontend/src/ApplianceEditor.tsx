import { useRef, useState, type FormEvent } from 'react';
import { Check, Info, Save } from 'lucide-react';
import { ApiError, type Api } from './api';
import { appliancePayload, blankAppliance, fromAppliance, suggestions, validateAppliance, type ApplianceForm, type FieldErrors } from './forms';
import type { Appliance, Profile } from './types';
import { Button, ErrorNotice, Field, Modal, submitFocus } from './components';

export function ApplianceEditor({ api, profile, original, close, saved, reload }: {
  api: Api; profile: Profile; original?: Appliance; close: () => void; saved: (name: string) => void; reload: () => void;
}) {
  const [form, setForm] = useState<ApplianceForm>(() => original ? fromAppliance(original) : { ...blankAppliance });
  const [confirmed, setConfirmed] = useState(false), [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null), [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  function change(name: keyof ApplianceForm, value: string) { setForm(previous => ({ ...previous, [name]: value })); setConfirmed(false); setErrors({}); }
  async function submit(event: FormEvent) {
    const errors = validateAppliance(form, confirmed); submitFocus(event, errors); setErrors(errors);
    if (Object.keys(errors).length || busy) return;
    setBusy(true); setFailure(null);
    try {
      const payload = appliancePayload(form, confirmed, original);
      await api.saveAppliance(profile.id, original ? payload : { ...payload, client_request_id: key.current }, original);
      saved(form.name.trim());
    } catch (error) {
      setFailure(error);
      if (error instanceof ApiError) setErrors(Object.fromEntries(error.details.filter(d => /^\/[a-z_]+$/.test(d.path)).map(d => [d.path.slice(1), d.message])));
    } finally { setBusy(false); }
  }
  const unknown = ['rated_watts', 'hours_per_day', 'effective_load_percent'].filter(field => !form[field as keyof ApplianceForm].trim()).length;
  return <Modal title={original ? 'Edit appliance' : 'Add an appliance'} close={close} busy={busy}>
    <form onSubmit={submit} noValidate aria-busy={busy}><fieldset disabled={busy}>
      <p className="form-intro">Use the rating on your appliance and your own usage estimate. Leave anything you don’t know blank.</p>
      {failure != null && <ErrorNotice error={failure} retry={failure instanceof ApiError && ['STALE_VERSION', 'IDEMPOTENCY_CONFLICT'].includes(failure.code) ? reload : undefined} />}
      <Field name="name" label="Appliance name" value={form.name} onChange={e => change('name', e.target.value)} error={errors.name} autoFocus maxLength={200} autoComplete="off" />
      {!original && <div className="suggestions" aria-label="Name suggestions">{suggestions[profile.sector].map(name => <button key={name} type="button" onClick={() => change('name', name)}>{name}</button>)}<span>Names only · add your own ratings below</span></div>}
      <div className="form-grid">
        <Field name="quantity" label="Quantity" value={form.quantity} inputMode="numeric" onChange={e => change('quantity', e.target.value)} error={errors.quantity} />
        <Field name="rated_watts" label="Rated power (W)" value={form.rated_watts} inputMode="decimal" placeholder="Unknown" onChange={e => change('rated_watts', e.target.value)} error={errors.rated_watts} hint="Use watts (W), not VA." />
        <Field name="hours_per_day" label="Hours used per day" value={form.hours_per_day} inputMode="decimal" placeholder="Unknown" onChange={e => change('hours_per_day', e.target.value)} error={errors.hours_per_day} hint="From 0 to 24 hours." />
        <Field name="effective_load_percent" label="Effective load (%)" value={form.effective_load_percent} inputMode="decimal" placeholder="Unknown" onChange={e => change('effective_load_percent', e.target.value)} error={errors.effective_load_percent} hint="Your explicit assumption, greater than 0 and up to 100%." />
      </div>
      <div className="notice subtle"><Info size={18} /><p>Effective load is the share of rated power you assume while the appliance is in use. If you’re unsure, leave it blank. We never assume 100%.</p></div>
      <details className="extra-fields"><summary>Brand, model and source details <span>Optional</span></summary><div className="form-grid">
        <Field name="brand" label="Brand" value={form.brand} onChange={e => change('brand', e.target.value)} error={errors.brand} maxLength={200} />
        <Field name="model" label="Model" value={form.model} onChange={e => change('model', e.target.value)} error={errors.model} maxLength={200} /></div>
        {form.source_method !== 'ai_label_extraction' && <Field name="source_method" label="Rating source"><select id="source_method" value={form.source_method} onChange={e => change('source_method', e.target.value)}><option value="manual">Entered manually</option><option value="document">Product document</option></select></Field>}
        <Field name="source_notes" label="Source notes" error={errors.source_notes}><textarea id="source_notes" value={form.source_notes} onChange={e => change('source_notes', e.target.value)} maxLength={2000} rows={2} /></Field>
      </details>
      {unknown > 0 && <div className="notice warning"><Info size={18} /><p>{unknown} estimate {unknown === 1 ? 'input is' : 'inputs are'} unknown. You can save this appliance, but it will be excluded from energy totals until all three inputs are known.</p></div>}
      <div className="confirmation"><label htmlFor="confirmation"><input id="confirmation" type="checkbox" checked={confirmed} onChange={e => { setConfirmed(e.target.checked); setErrors(previous => ({ ...previous, confirmation: '' })); }} aria-invalid={!!errors.confirmation} aria-describedby={errors.confirmation ? 'confirmation-error' : undefined} /><span>I reviewed the values above, including any intentional unknowns.</span><Check size={16} /></label>
        {errors.confirmation && <p id="confirmation-error" className="field-error">{errors.confirmation}</p>}</div>
      <div className="modal-footer"><Button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}><Save size={16} />{busy ? 'Saving…' : original ? 'Save changes' : 'Save appliance'}</Button></div>
    </fieldset></form>
  </Modal>;
}
