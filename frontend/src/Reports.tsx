import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FileText, Printer } from 'lucide-react';
import type { Api } from './api';
import { Button, ErrorNotice } from './components';
import { energy, text, type Assessment, type EnergyReport } from './types';
import { sameReportTotals } from './reporting';
import './reports.css';

export function ReportLauncher({ api, profileId, parameters, assessment, open }: {
  api: Api; profileId: string; parameters: { days: string; tariff: string }; assessment: Assessment;
  open: (id: string, changed: boolean) => void;
}) {
  const requestId = useRef(crypto.randomUUID()), active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function create() {
    if (busy) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setFailure(null);
    try {
      const report = await api.createReport(profileId, parameters.days, parameters.tariff, requestId.current, controller.signal);
      if (!controller.signal.aborted) open(report.id, !sameReportTotals(assessment, report.calculation));
    } catch (error) { if (!controller.signal.aborted) setFailure(error); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section id="reports" className="panel report-launcher" aria-labelledby="reports-title">
    <div><p className="eyebrow">A PICTURE YOU CAN KEEP</p><h2 id="reports-title">Reports &amp; exports</h2>
      <p>Save a snapshot for {parameters.days} days with the applied tariff, assumptions and incomplete appliances. Later edits won’t change it.</p>
      <p>Reports include the entire profile, regardless of the appliance search or filter.</p></div>
    <Button disabled={busy} onClick={() => void create()}><FileText size={17} />{busy ? 'Saving report…' : 'Save report'}</Button>
    {failure != null && <ErrorNotice error={failure} />}
  </section>;
}

function known(value: Parameters<typeof text>[0], suffix = '') { return value == null ? 'Unknown' : text(value) + suffix; }

export function ReportPage({ api, id, changed, back }: { api: Api; id: string; changed: boolean; back: (report?: EnergyReport) => void }) {
  const [report, setReport] = useState<EnergyReport | null>(null), [failure, setFailure] = useState<unknown>(null);
  const [loading, setLoading] = useState(true), [downloading, setDownloading] = useState(false), [revision, setRevision] = useState(0);
  const activeDownload = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setReport(null); setFailure(null);
    api.report(id, controller.signal).then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(error => { if (!controller.signal.aborted) setFailure(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); activeDownload.current?.abort(); };
  }, [api, id, revision]);
  useEffect(() => {
    const previous = document.title; document.title = report ? `Energy report ${report.id} · PowerShift AI` : 'Energy report · PowerShift AI';
    return () => { document.title = previous; };
  }, [report]);
  async function download() {
    if (!report || downloading) return;
    const controller = new AbortController(); activeDownload.current = controller; setDownloading(true); setFailure(null);
    try {
      const blob = await api.reportCsv(report.id, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `powershift-${report.id}.csv`; document.body.append(link); link.click(); link.remove();
      // Give the browser time to begin the download before releasing the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (!controller.signal.aborted) setFailure(error); }
    finally { if (!controller.signal.aborted) setDownloading(false); }
  }
  const calc = report?.calculation;
  const rows = new Map(calc?.rows.map(row => [row.id, row]));
  return <div className="report-page"><a className="skip-link" href="#report-main">Skip to report</a>
    <nav className="report-toolbar" aria-label="Report actions"><Button className="secondary" onClick={() => back(report || undefined)}><ArrowLeft size={16} />Back to dashboard</Button>
      {report && <div><Button className="secondary" disabled={downloading} onClick={() => void download()}><Download size={16} />{downloading ? 'Downloading…' : 'Download CSV'}</Button>
        <Button onClick={() => window.print()}><Printer size={16} />Print report</Button></div>}</nav>
    <main id="report-main" className="report-paper" aria-busy={loading}>
      <header className="report-heading"><p className="eyebrow">POWERSHIFT AI · SAVED ESTIMATE</p><h1>Energy estimate report</h1>
        <p>Rated-power estimates with customer-supplied usage. Not meter readings or an actual bill.</p></header>
      {loading && <p role="status">Loading saved report…</p>}
      {failure != null && <ErrorNotice error={failure} retry={!report ? () => setRevision(value => value + 1) : undefined} />}
      {report && calc && <>
        {changed && <div role="status" className="notice warning report-screen-only">The profile changed since the dashboard estimate. This report uses the latest saved inputs captured by the server.</div>}
        <dl className="report-meta"><div><dt>Report ID</dt><dd>{report.id}</dd></div><div><dt>Profile ID</dt><dd>{report.profile_id}</dd></div>
          <div><dt>Captured (UTC)</dt><dd><time dateTime={report.created_at}>{new Date(report.created_at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time></dd></div>
          <div><dt>Period</dt><dd>{text(calc.period_days)} days · usage projection, not a dated meter interval</dd></div>
          <div><dt>Tariff</dt><dd>{calc.rate_ngn_per_kwh == null ? 'Not supplied — no cost estimate' : `NGN ${text(calc.rate_ngn_per_kwh)} / kWh · user input · all-grid scenario`}</dd></div></dl>
        <section className="report-summary" aria-label="Report totals">
          <article aria-label="Report daily energy"><h2>Daily energy</h2><p><strong>{energy(calc.totals.daily_kwh)}</strong> kWh / day</p></article>
          <article aria-label="Report period energy"><h2>{text(calc.period_days)}-day energy</h2><p><strong>{energy(calc.totals.period_kwh)}</strong> kWh</p></article>
          <article aria-label="Report grid-equivalent cost"><h2>Grid-equivalent cost</h2><p><strong>{calc.totals.grid_equivalent_cost_ngn == null ? 'Not estimated' : 'NGN ' + calc.totals.grid_equivalent_cost_ngn}</strong></p></article>
        </section>
        <p className="report-counts">{text(calc.counts.total)} appliances · {text(calc.counts.eligible)} included · {text(calc.counts.incomplete)} incomplete · {text(calc.counts.invalid)} invalid · {text(calc.counts.unconfirmed)} unconfirmed</p>
        <section className="report-warnings" aria-labelledby="report-warnings-title"><h2 id="report-warnings-title">Warnings &amp; exclusions</h2>
          {calc.warnings.length ? <ul>{calc.warnings.map((warning, index) => <li key={warning.code + index}><strong>{warning.code}</strong>: {warning.message}</li>)}</ul> : <p>No additional warnings.</p>}
          <p>Unknown inputs and excluded results are not zero. Rounded rows may differ visually from the independently rounded aggregate.</p></section>
        <section className="report-breakdown" aria-labelledby="report-breakdown-title"><h2 id="report-breakdown-title">Appliance breakdown</h2>
          {!report.input_snapshot.appliances.length ? <p>No appliances were saved in this snapshot. No energy or cost estimate is available.</p>
            : <><p className="report-table-hint" id="report-table-hint">Scroll the table horizontally to see every column. When focused, use the arrow keys.</p><div className="report-table-wrap" role="region" aria-label="Saved appliance details" tabIndex={0}><table><caption>Saved inputs and server-calculated estimates for every appliance</caption><thead><tr><th>Appliance / status</th><th>Qty</th><th>Power (W)</th><th>Hours/day</th><th>Load (%)</th><th>Daily kWh</th><th>Period kWh</th></tr></thead>
              <tbody>{report.input_snapshot.appliances.map(item => { const row = rows.get(item.id); return <tr key={item.id}>
                <th scope="row"><span>{item.name}</span><small>{row?.status || 'Unavailable'} · {item.source_method.replaceAll('_', ' ')}</small>
                  {row?.issues.map((issue, index) => <small key={issue.path + index}>{issue.path.split('/').at(-1)}: {issue.message} ({issue.code})</small>)}</th>
                <td>{text(item.quantity)}</td><td>{known(item.rated_watts)}</td><td>{known(item.hours_per_day)}</td><td>{known(item.effective_load_percent)}</td>
                <td>{row?.daily_kwh == null ? 'Excluded' : energy(row.daily_kwh)}</td><td>{row?.period_kwh == null ? 'Excluded' : energy(row.period_kwh)}</td></tr>; })}</tbody></table></div></>}
        </section>
        <section className="report-assumptions" aria-labelledby="report-assumptions-title"><h2 id="report-assumptions-title">Assumptions &amp; boundaries</h2><ul>{calc.assumptions.map((value, index) => <li key={index}>{value}</li>)}</ul></section>
        <footer className="report-footer"><p>This immutable snapshot preserves the captured appliance values, confirmation and provenance. Later appliance edits do not update it.</p>
          <p>Bookmark this report’s URL to reopen it. Access requires your authorized account. CSV contains one row per saved appliance; empty snapshots export the contracted header only.</p>
          <p>PowerShift AI · Estimates, not measured consumption.</p></footer>
      </>}
    </main></div>;
}
