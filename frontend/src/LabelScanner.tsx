import { useEffect, useRef, useState } from 'react';
import type { Api } from './api';
import type { ScanNotice, ScanResponse } from './types';
import { Button, ErrorNotice } from './components';

export function LabelScanner({ api, profileId, received, busyChanged }: {
  api: Api; profileId: string; received: (value: ScanResponse) => void; busyChanged: (value: boolean) => void;
}) {
  const [notice, setNotice] = useState<ScanNotice | null>(null), [opened, setOpened] = useState(false);
  const [image, setImage] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null), [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null), reader = useRef<FileReader | null>(null);
  useEffect(() => () => { active.current?.abort(); reader.current?.abort(); }, []);
  useEffect(() => { busyChanged(busy); return () => busyChanged(false); }, [busy, busyChanged]);
  async function open() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setFailure(null); setBusy(true); setOpened(true);
    try {
      const status = await api.scanStatus(controller.signal);
      if (!status.imageScanningConfigured || !status.scanNotice) setMessage('Label scanning is not configured. You can enter all values manually below.');
      else { setNotice(status.scanNotice); setMessage(''); }
    } catch (error) { if (!controller.signal.aborted) setFailure(error); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function choose(file?: File) {
    reader.current?.abort(); setImage(''); setConsent(false); setFailure(null); setMessage('');
    if (!file || !notice) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > Number(notice.maxImageBytes)) {
      setMessage('Choose one JPEG, PNG or WebP within the upload limit. Manual entry is available below.'); return;
    }
    const next = new FileReader(); reader.current = next;
    next.onload = () => { if (reader.current === next) setImage(String(next.result)); };
    next.onerror = () => setMessage('This file could not be read. Choose another photo or enter values manually.');
    next.readAsDataURL(file);
  }
  async function scan() {
    if (!image || !consent || !notice || busy) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setFailure(null);
    try {
      const result = await api.scan({ imageDataUrl: image, profile_id: profileId,
        consent: { granted: true, notice_version: notice.version } }, (Number(notice.timeoutSeconds) + 15) * 1000, controller.signal);
      if (!controller.signal.aborted) { received(result); setImage(''); setConsent(false); setOpened(false); }
    } catch (error) { if (!controller.signal.aborted) setFailure(error); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="label-scanner" aria-label="Optional label scan">
    <Button type="button" className="secondary" onClick={() => void open()} disabled={busy}>Read an appliance label</Button>
    {opened && <div aria-busy={busy}>
      <p>Scanning is optional. You can always enter the appliance details yourself.</p>
      {notice && <><p id="scan-notice">{notice.text}</p><label htmlFor="label-photo">Label photo (JPEG, PNG or WebP; up to {Number(notice.maxImageBytes) / 1048576} MiB)</label>
        <input id="label-photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => choose(e.target.files?.[0])} />
        {image && <img className="label-preview" src={image} alt="Selected appliance label for review" />}
        <label className="scan-consent"><input type="checkbox" checked={consent} disabled={busy} aria-describedby="scan-notice" onChange={e => setConsent(e.target.checked)} /> I agree to the local photo processing described above.</label>
        <Button type="button" onClick={() => void scan()} disabled={!image || !consent || busy}>{busy ? 'Reading label…' : 'Extract label values'}</Button></>}
      {message && <p role="status">{message}</p>}{failure != null && <ErrorNotice error={failure} />}
      {busy && <p role="status">The local model may take a while. Your manual inputs are kept.</p>}
      <Button type="button" className="secondary" onClick={() => { active.current?.abort(); reader.current?.abort(); setBusy(false); setOpened(false); setImage(''); setConsent(false); }}>Continue manually</Button>
    </div>}
  </section>;
}
