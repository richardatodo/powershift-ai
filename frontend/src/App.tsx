import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Building2, CalendarDays, Check, ChevronDown, CircleHelp, Home, Info, LayoutDashboard, Leaf, ListChecks, LoaderCircle, LogOut, Pencil, Plus, RefreshCw, Search, ShieldCheck, Sun, Trash2, Wallet, Zap } from 'lucide-react';
import { ApiError, type Api } from './api';
import { useAuth } from './auth';
import { Button, EmptyState, ErrorNotice, Field, Modal, submitFocus } from './components';
import { ApplianceEditor } from './ApplianceEditor';
import { numberError } from './forms';
import { energy, sectors, text, type Appliance, type Assessment, type Profile, type Sector, type Workspace } from './types';

function Brand() { return <a className="brand" href="/" aria-label="PowerShift AI home"><span className="brand-mark"><Zap size={23} fill="currentColor" /></span><span>PowerShift<span className="brand-ai">AI</span></span></a>; }
function Landing() {
  const auth = useAuth();
  return <div className="landing"><header><Brand /><span className="pill"><Leaf size={14} /> ENERGY, UNDERSTOOD</span></header>
    <main className="landing-main"><div><p className="eyebrow">A LITTLE KNOWLEDGE. A CLEARER PICTURE.</p>
      <h1>Understand the energy<br />behind your everyday.</h1><p className="landing-copy">Bring your appliances into focus. Turn the ratings and routines you know into clear estimates, with every assumption in view.</p>
      {auth.error && <div role="alert" className="notice error">{auth.error}</div>}
      {!auth.configured ? <div className="notice subtle"><ShieldCheck size={21} /><div><strong>Your private workspace is waiting.</strong><p>Sign-in is not connected yet. Your workspace administrator needs to connect your identity provider before you can continue.</p></div></div>
        : <Button onClick={() => void auth.signIn()}>Sign in to your workspace <ArrowRight size={18} /></Button>}
      <p className="landing-foot"><ShieldCheck size={15} /> Your profiles stay private to your account.</p></div>
      <div className="landing-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-core"><Zap size={76} strokeWidth={1.2} /></div><div className="art-note note-top"><Sun size={18} /><span>YOUR DAILY ROUTINES</span></div><div className="art-note note-bottom"><Check size={18} /><span>CLEARER ASSUMPTIONS</span></div></div>
    </main><footer>Built for homes and businesses in Nigeria.<span>Estimates you can understand. Inputs you control.</span></footer></div>;
}
function ProfileEditor({ api, close, saved }: { api: Api; close: () => void; saved: (profile: Profile) => void }) {
  const [name, setName] = useState(''), [sector, setSector] = useState<Sector>('home');
  const [error, setError] = useState(''), [failure, setFailure] = useState<unknown>(null), [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  async function submit(event: FormEvent) {
    const error = !name.trim() || name.trim().length > 200 ? 'Enter a profile name, up to 200 characters.' : '';
    submitFocus(event, error ? { profile_name: error } : {}); setError(error);
    if (error || busy) return;
    setBusy(true); setFailure(null);
    try { saved(await api.createProfile({ name: name.trim(), sector, currency: 'NGN', client_request_id: requestId.current })); }
    catch (error) { setFailure(error); } finally { setBusy(false); }
  }
  return <Modal title="Create a profile" close={close} busy={busy}><form onSubmit={submit} noValidate><fieldset disabled={busy}>
    <p className="form-intro">Give each home or business its own space. Appliances and estimates stay together.</p>
    {failure != null && <ErrorNotice error={failure} />}
    <Field name="profile_name" label="Profile name" placeholder="For example, My home" value={name} onChange={e => { setName(e.target.value); setError(''); }} maxLength={200} error={error} autoFocus />
    <Field name="sector" label="Type of space"><select id="sector" value={sector} onChange={e => setSector(e.target.value as Sector)}>{sectors.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
    <div className="notice subtle"><Info size={18} /><p>Your space type suggests appliance names only. It never fills in power ratings or usage assumptions.</p></div>
    <div className="modal-footer"><Button type="button" className="secondary" onClick={close}>Cancel</Button><Button type="submit">{busy ? 'Creating…' : 'Create profile'}<ArrowRight size={16} /></Button></div>
  </fieldset></form></Modal>;
}
function EstimateSettings({ applied, apply, disabled }: { applied: { days: string; tariff: string }; apply: (value: { days: string; tariff: string }) => void; disabled: boolean }) {
  const [days, setDays] = useState(applied.days), [tariff, setTariff] = useState(applied.tariff), [errors, setErrors] = useState<Record<string, string>>({});
  function submit(event: FormEvent) {
    const errors: Record<string, string> = {}, dayError = numberError(days.trim(), '1', '366', false, true);
    const rateError = tariff.trim() ? numberError(tariff.trim(), '0') : null;
    if (dayError) errors.period_days = dayError;
    if (rateError) errors.tariff = rateError;
    submitFocus(event, errors); setErrors(errors);
    if (!Object.keys(errors).length) apply({ days: days.trim(), tariff: tariff.trim() });
  }
  const changed = days.trim() !== applied.days || tariff.trim() !== applied.tariff;
  return <section className="settings-panel" aria-labelledby="settings-title"><div><p className="eyebrow">YOUR ESTIMATE, YOUR CONTEXT</p><h2 id="settings-title">Set the reporting period</h2><p>Tariff is optional. Use your own NGN per kWh rate.</p></div>
    <form onSubmit={submit} noValidate><Field name="period_days" label="Period (days)" value={days} inputMode="numeric" onChange={e => setDays(e.target.value)} error={errors.period_days} />
      <Field name="tariff" label="Tariff (₦ / kWh) · optional" value={tariff} inputMode="decimal" placeholder="Not supplied" onChange={e => setTariff(e.target.value)} error={errors.tariff} />
      <Button type="submit" className="secondary" disabled={disabled}><RefreshCw size={15} />Update estimate</Button>
      {changed && <p className="draft-note">Apply to update the results below.</p>}</form></section>;
}
function Metrics({ assessment, days, loading }: { assessment: Assessment | null; days: string; loading: boolean }) {
  const cards = [
    { label: 'Daily energy', value: energy(assessment?.totals.daily_kwh), unit: 'kWh / day', icon: Sun, hint: 'From complete, confirmed appliances', accent: true },
    { label: `${days}-day energy`, value: energy(assessment?.totals.period_kwh), unit: 'kWh', icon: CalendarDays, hint: `Estimated over ${days} days` },
    { label: 'Grid-equivalent cost', value: assessment?.totals.grid_equivalent_cost_ngn == null ? '—' : '₦' + assessment.totals.grid_equivalent_cost_ngn, unit: '', icon: Wallet,
      hint: assessment?.rate_ngn_per_kwh == null ? 'Add your tariff to estimate cost' : 'All-grid scenario · not an actual bill' },
  ];
  return <div className="metrics">{cards.map(({ label, value, unit, icon: Icon, hint, accent }) => <article key={label} className={`metric ${accent ? 'accent' : ''}`} aria-label={label}>
    <div className="metric-top"><span>{label}</span><Icon size={19} /></div><div className="metric-number" title={value}>{loading ? <span className="skeleton-number">Loading…</span> : value}<span>{unit}</span></div><p>{hint}</p>
  </article>)}</div>;
}
function InputsGuide() {
  return <section className="guide-card" aria-labelledby="guide-title"><div className="guide-symbol"><Leaf size={24} /></div><p className="eyebrow">KEEP IT GROUNDED</p><h2 id="guide-title">Good estimates start<br />with honest inputs.</h2><p>A nameplate rating is a starting point. Real operating draw can vary.</p><div className="guide-rule" /><p><strong>Don’t know a value?</strong><br />Leave it blank. We’ll show what’s missing instead of guessing.</p><a href="#assumptions">Understand the assumptions <ArrowUpRight size={15} /></a></section>;
}
function EnergyBreakdown({ rows, assessment }: { rows: Appliance[]; assessment: Assessment | null }) {
  const eligible = rows.filter(row => row.calculated_daily_kwh !== null);
  const units = (value: string) => BigInt(value.replace('.', ''));
  const largest = eligible.reduce((value, row) => { const next = units(row.calculated_daily_kwh!); return next > value ? next : value; }, 0n);
  return <section className="panel breakdown" aria-labelledby="breakdown-title"><div className="section-title"><div><p className="eyebrow">THE EVERYDAY PICTURE</p><h2 id="breakdown-title">Energy by appliance</h2></div><span className="small-muted">kWh / day</span></div>
    {!assessment || !eligible.length ? <div className="breakdown-empty"><ListChecks size={28} /><p>Complete appliance inputs to see their daily estimates here.</p></div> : eligible.map(row => <div className="energy-row" key={row.id}><div><span>{row.name}</span><strong>{energy(row.calculated_daily_kwh)}</strong></div><div className="bar-track" aria-hidden="true"><div style={{ width: largest ? `${Number(units(row.calculated_daily_kwh!) * 100n / largest)}%` : '0%' }} /></div></div>)}
    <p className="chart-foot">Only complete, customer-confirmed appliances are included. Bars compare the displayed estimates.</p>
  </section>;
}

function Dashboard() {
  const { api, signOut } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [assessment, setAssessment] = useState<Assessment | null>(null);
  const [pageLoading, setPageLoading] = useState(true), [loading, setLoading] = useState(false), [failure, setFailure] = useState<unknown>(null);
  const [revision, setRevision] = useState(0), [listRevision, setListRevision] = useState(0), [notice, setNotice] = useState('');
  const [profileModal, setProfileModal] = useState(false), [editor, setEditor] = useState<Appliance | 'new' | null>(null), [removing, setRemoving] = useState<Appliance | null>(null), [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState<unknown>(null);
  const [parameters, setParameters] = useState({ days: '30', tariff: '' }), [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const listRef = useRef<HTMLElement>(null), addRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setPageLoading(true); setFailure(null);
    api.profiles(undefined, controller.signal).then(page => {
      setProfiles(page.profiles); setCursor(page.next_cursor); setSelected(previous => previous || page.profiles[0]?.id || '');
    }).catch(error => { if (!controller.signal.aborted) setFailure(error); }).finally(() => { if (!controller.signal.aborted) setPageLoading(false); });
    return () => controller.abort();
  }, [api, listRevision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); setWorkspace(null); setAssessment(null); setFailure(null); setLoading(true);
    void (async () => {
      try {
        const data = await api.profile(selected, controller.signal);
        if (controller.signal.aborted) return;
        setWorkspace(data);
        const result = await api.calculate(data.appliances, parameters.days, parameters.tariff, controller.signal);
        if (!controller.signal.aborted) setAssessment(result);
      } catch (error) { if (!controller.signal.aborted) setFailure(error); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [api, selected, revision, parameters]);
  function refresh() { setWorkspace(null); setAssessment(null); setRevision(value => value + 1); }
  function selectProfile(id: string) { setWorkspace(null); setAssessment(null); setSelected(id); setParameters({ days: '30', tariff: '' }); setSearch(''); setFilter('all'); setNotice(''); }
  function reload() { setEditor(null); setRemoving(null); refresh(); }
  async function moreProfiles() {
    try { const page = await api.profiles(cursor || undefined); setProfiles(previous => [...previous, ...page.profiles.filter(p => !previous.some(old => old.id === p.id))]); setCursor(page.next_cursor); }
    catch (error) { setFailure(error); }
  }
  async function deleteAppliance() {
    if (!removing || deleting) return;
    setDeleting(true); setDeleteError(null);
    try { await api.remove(removing); setNotice(`${removing.name} deleted.`); setRemoving(null); refresh(); }
    catch (error) { setDeleteError(error); } finally { setDeleting(false); }
  }
  const current = workspace?.profile || profiles.find(profile => profile.id === selected);
  const rows = workspace?.appliances || [];
  const visible = rows.filter(row => (filter !== 'incomplete' || row.calculation_status === 'incomplete') && row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const incomplete = rows.filter(row => row.calculation_status === 'incomplete').length;
  function showIncomplete() { setFilter('incomplete'); listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  return <div className="app-shell"><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><Brand />
    <div className="workspace-picker"><label htmlFor="active-profile">CURRENT PROFILE</label><div className="profile-select"><Home size={17} /><select id="active-profile" value={selected} onChange={event => selectProfile(event.target.value)} disabled={!profiles.length}>{!profiles.length && <option value="">No profiles yet</option>}{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name || sectors.find(s => s.value === profile.sector)?.label + ' · ' + profile.id.slice(0, 6)}</option>)}</select><ChevronDown size={14} /></div>
      {cursor && <button className="text-button" onClick={() => void moreProfiles()}>Load more profiles</button>}<button className="new-profile" onClick={() => setProfileModal(true)}><Plus size={15} />New profile</button></div>
    <nav aria-label="Workspace"><p className="eyebrow">WORKSPACE</p><a className="nav-link active" href="#overview"><LayoutDashboard size={18} />Overview<span className="nav-dot" /></a><a className="nav-link" href="#appliances"><ListChecks size={18} />Appliances<span className="nav-count">{rows.length}</span></a><a className="nav-link" href="#assumptions"><CircleHelp size={18} />Assumptions</a></nav>
    <div className="sidebar-bottom"><div className="private-note"><ShieldCheck size={20} /><span>A private space.<br /><strong>Your inputs stay yours.</strong></span></div><button className="signout" onClick={() => void signOut()}><LogOut size={16} />Sign out</button><p className="sidebar-footer">MADE FOR EVERYDAY CLARITY</p></div>
  </aside><div className="workspace-main"><header className="topbar"><span><span className="breadcrumb">Workspace</span><span className="slash">/</span>{current?.name || 'Overview'}</span><span className="pill"><span className="status-dot" /> MANUAL WORKSPACE</span></header>
    <main id="main"><section id="overview" className="page-heading"><div><p className="eyebrow">SMALL DETAILS. A CLEARER PICTURE.</p><h1>Your energy, made clearer<span>.</span></h1><p>Understand what you use. Keep every assumption in view.</p></div><Button onClick={() => workspace ? setEditor('new') : setProfileModal(true)} disabled={loading || pageLoading} ref={addRef}><Plus size={18} />{selected ? 'Add appliance' : 'Create profile'}</Button></section>
      {notice && <div role="status" className="success-message"><Check size={16} />{notice}</div>}
      {failure != null && <ErrorNotice error={failure} retry={() => selected ? refresh() : setListRevision(value => value + 1)} />}
      {pageLoading ? <div className="loading-state" role="status"><LoaderCircle className="spin" />Opening your workspace…</div>
        : !profiles.length && !failure ? <EmptyState kind="profiles" action={() => setProfileModal(true)} /> : <>
          {current && <EstimateSettings key={selected} applied={parameters} disabled={loading || !workspace} apply={value => { setAssessment(null); setParameters(value); }} />}
          <Metrics assessment={assessment} days={parameters.days} loading={loading} />
          {incomplete > 0 && <div className="notice warning incomplete-banner"><Info size={20} /><div><strong>{incomplete} {incomplete === 1 ? 'appliance needs' : 'appliances need'} a little more detail.</strong><p>Unknown ratings or usage stay out of the totals. They’re never treated as zero.</p></div><button className="text-button" onClick={showIncomplete}>Review incomplete <ArrowRight size={16} /></button></div>}
          {assessment && text(assessment.counts.eligible) === '0' && <p className="no-estimate"><Info size={15} />No complete, confirmed appliances are available for an estimate yet.</p>}
          <div className="insights-grid"><EnergyBreakdown rows={rows} assessment={assessment} /><InputsGuide /></div>
          <section id="appliances" ref={listRef} className="panel appliances" aria-labelledby="appliances-title"><div className="section-title"><div><p className="eyebrow">YOUR EVERYDAY ESSENTIALS</p><h2 id="appliances-title">Appliances <span className="count-badge">{rows.length}</span></h2></div><button className="text-button" disabled={!workspace} onClick={() => setEditor('new')}><Plus size={16} />Add appliance</button></div>
            <div className="list-toolbar"><div className="segmented" aria-label="Appliance filter"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All appliances</button><button aria-pressed={filter === 'incomplete'} onClick={() => setFilter('incomplete')}>Needs details <span>{incomplete}</span></button></div><label className="search"><Search size={16} /><input aria-label="Search appliances" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find an appliance…" /></label></div>
            {loading && !workspace ? <div role="status" className="loading-state">Loading appliances…</div> : rows.length === 0 ? <EmptyState kind="appliances" action={() => setEditor('new')} /> : visible.length === 0 ? <p className="no-matches">No appliances match this view. Try another search or filter.</p> : <div className="table-wrap"><table><thead><tr><th>Appliance</th><th>Qty</th><th>Rated power</th><th>Use / day</th><th>Load</th><th>Daily estimate</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><td><span className="appliance-name">{row.name}</span><span className={`row-status ${row.calculation_status === 'eligible' ? 'included' : 'needs'}`}>{row.calculation_status === 'eligible' ? <Check size={11} /> : <Info size={11} />}{row.calculation_status === 'eligible' ? 'Included' : 'Needs details'}</span></td><td data-label="Quantity">{text(row.quantity)}</td><td data-label="Rated power">{row.rated_watts == null ? <span className="unknown">Unknown</span> : text(row.rated_watts) + ' W'}</td><td data-label="Use / day">{row.hours_per_day == null ? <span className="unknown">Unknown</span> : text(row.hours_per_day) + ' h'}</td><td data-label="Effective load">{row.effective_load_percent == null ? <span className="unknown">Unknown</span> : text(row.effective_load_percent) + '%'}</td><td data-label="Daily estimate"><strong>{energy(row.calculated_daily_kwh)}</strong>{row.calculated_daily_kwh !== null && <span className="unit"> kWh</span>}</td><td className="row-actions"><button className="icon-button" aria-label={`Edit ${row.name}`} onClick={() => setEditor(row)}><Pencil size={16} /></button><button className="icon-button danger" aria-label={`Delete ${row.name}`} onClick={() => { setRemoving(row); setDeleteError(null); }}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div>}
            <div className="table-footer"><ShieldCheck size={14} />Values are customer-confirmed. Unknowns remain unknown.</div></section>
          <section id="assumptions" className="assumptions" aria-labelledby="assumptions-title"><div><p className="eyebrow">THE IMPORTANT CONTEXT</p><h2 id="assumptions-title">An estimate, with its assumptions.</h2><p>Clear boundaries make the numbers more useful.</p></div><div><ul>{(assessment?.assumptions || ['Energy is estimated from appliance ratings and your usage inputs. It is not measured by a meter.', 'Unknown watts, hours or effective load are never filled in automatically.', 'Without a tariff, no cost estimate is shown.']).map(item => <li key={item}><Check size={14} />{item}</li>)}</ul>{assessment?.warnings.filter(item => item.code === 'ROUNDING_APPLIED').map(item => <p className="rounding-note" key={item.code}>{item.message}</p>)}</div></section>
        </>}
      <footer className="page-footer"><span>PowerShift AI <span>·</span> Clarity for everyday energy.</span><span>Estimates, not meter readings.</span></footer>
    </main></div>
    {profileModal && <ProfileEditor api={api} close={() => setProfileModal(false)} saved={profile => { setProfiles(previous => [...previous.filter(p => p.id !== profile.id), profile]); selectProfile(profile.id); setProfileModal(false); setNotice(`${profile.name} created.`); }} />}
    {editor && workspace && <ApplianceEditor api={api} profile={workspace.profile} original={editor === 'new' ? undefined : editor} close={() => { setEditor(null); addRef.current?.focus(); }} reload={reload} saved={name => { setEditor(null); setNotice(`${name} saved.`); refresh(); addRef.current?.focus(); }} />}
    {removing && <Modal title="Delete this appliance?" close={() => setRemoving(null)} busy={deleting}><p className="form-intro"><strong>{removing.name}</strong> will be removed from this profile and future estimates. Previously saved reports keep their original snapshot.</p>{deleteError != null && <ErrorNotice error={deleteError} retry={deleteError instanceof ApiError && deleteError.code === 'STALE_VERSION' ? reload : undefined} />}<div className="modal-footer"><Button className="secondary" onClick={() => setRemoving(null)} disabled={deleting}>Keep appliance</Button><Button className="destructive" onClick={() => void deleteAppliance()} disabled={deleting}><Trash2 size={16} />{deleting ? 'Deleting…' : 'Delete appliance'}</Button></div></Modal>}
  </div>;
}
export default function App() {
  const auth = useAuth();
  const identity = useMemo(() => auth.user ? `${auth.user.profile.iss}:${auth.user.profile.sub}` : '', [auth.user]);
  if (!auth.ready) return <div className="app-opening" role="status"><Zap className="spin" />Opening PowerShift…</div>;
  return auth.user ? <Dashboard key={identity} /> : <Landing />;
}
