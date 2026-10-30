import React, {useState} from 'react';
import {Copy, Eye, PlugZap, RotateCcw, ShieldOff} from 'lucide-react';
import {api} from '../api/client.js';
import {useApiMutation, useRouters, useSubscriptions} from '../api/hooks.js';
import {useConfirm, useToast} from '../components/feedback.jsx';
import {Alert, Button, Checkbox, Details, Dialog, Field, FormActions, NetworkStatus} from '../components/ui.jsx';
import {useAuth} from '../lib/auth.jsx';
import {fmtDateTime} from '../lib/format.js';

// Toast untuk hasil sinkron router yang menyertai respons API (network_result).
export function useNetworkResultToast() {
  const toast = useToast();
  return result => {
    if (!result || result.skipped) return;
    if (result.ok) toast('Router: ' + (result.message || 'tersinkron'));
    else toast('Status tersimpan, tetapi router gagal: ' + result.error, 'error');
  };
}

export default function NetworkForm({serviceId, onClose}) {
  const {session} = useAuth();
  const isAdmin = session.role === 'admin';
  const service = (useSubscriptions().data || []).find(s => s.id === serviceId);
  const routers = useRouters().data || [];
  const save = useApiMutation();
  const action = useApiMutation();
  const confirm = useConfirm();
  const showResult = useNetworkResultToast();
  const [credentials, setCredentials] = useState(null);
  const toast = useToast();

  if (!service) return null;
  const mapped = Boolean(service.router_id && service.pppoe_username);
  const installed = ['provisioned', 'isolated'].includes(service.network_state);
  const pending = service.status === 'pending';

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      router_id: raw.router_id ? Number(raw.router_id) : null,
      pppoe_username: raw.pppoe_username?.trim() || null,
      pppoe_password: raw.pppoe_password || null,
      provision: raw.provision === 'on',
    };
    save.mutate({path: `/subscriptions/${service.id}/network`, method: 'PUT', body, success: 'Pemetaan jaringan tersimpan'}, {onSuccess: data => showResult(data.result)});
  };

  const run = async (path, label, needsConfirm) => {
    if (needsConfirm && !await confirm(needsConfirm)) return;
    action.mutate({path: `/subscriptions/${service.id}/network/${path}`, success: label}, {onSuccess: data => showResult(data.result)});
  };

  const reveal = async () => {
    try { setCredentials(await api(`/subscriptions/${service.id}/network/credentials`)); }
    catch (err) { toast(err.message, 'error'); }
  };

  return (
    <Dialog title={'Jaringan · ' + service.code} onClose={onClose} size="lg">
      <div className="dialog-body">
        <Details columns={2} entries={[
          ['Pelanggan', service.customer_name], ['Paket', service.plan_name],
          ['Status jaringan', <NetworkStatus key="s" state={service.network_state} reason={service.isolation_reason}/>],
          ['Sinkron terakhir', service.network_synced_at ? fmtDateTime(service.network_synced_at) : null],
        ]}/>
        {service.network_error && <Alert tone="error">Router: {service.network_error}</Alert>}
        <Alert tone="error">{(save.error || action.error)?.message}</Alert>

        <form onSubmit={submit} key={`${service.router_id}-${service.pppoe_username}`}>
          <div className="grid-2">
            <Field label="Router (NAS/BRAS)" name="router_id" defaultValue={service.router_id ? String(service.router_id) : ''} disabled={installed && !isAdmin}>
              <option value="">Tidak dipetakan</option>
              {routers.map(r => <option key={r.id} value={r.id} disabled={!r.enabled}>{r.name} · {r.host}{r.enabled ? '' : ' (nonaktif)'}</option>)}
            </Field>
            <Field label="Username PPPoE" name="pppoe_username" defaultValue={service.pppoe_username || ''} placeholder={service.code.toLowerCase()} maxLength={100}
              pattern="[A-Za-z0-9._@\-]*" hint="Kosongkan untuk memakai Service ID"/>
          </div>
          <Field label="Password PPPoE" name="pppoe_password" type="password" autoComplete="new-password" maxLength={100}
            placeholder={mapped ? 'Kosongkan = password lama tetap' : 'Kosongkan = dibuat otomatis (12 karakter)'}/>
          <Checkbox name="provision" defaultChecked={!pending} disabled={pending} label="Kirim ke router sekarang"
            hint={pending ? 'Layanan pending di-provision otomatis saat NOC mengaktifkan ticket.' : 'Membuat/memperbarui PPP secret sesuai profile paket.'}/>
          {!routers.length && <Alert>Belum ada router. Tambahkan di menu Network & RADIUS.</Alert>}
          <FormActions onCancel={onClose} pending={save.isPending} submitLabel="Simpan Pemetaan"/>
        </form>

        {mapped && (
          <section className="net-actions">
            <h3>Aksi router</h3>
            <div>
              <Button variant="secondary" icon={PlugZap} disabled={pending || action.isPending} onClick={() => run('provision', 'Provisioning dikirim')}>Provision ulang</Button>
              {isAdmin && <Button variant="secondary" icon={ShieldOff} disabled={pending || action.isPending || service.network_state === 'isolated'}
                onClick={() => run('isolate', 'Layanan diisolir', {title: 'Isolir layanan ini?', body: `${service.pppoe_username} akan dinonaktifkan/dipindah ke profile isolir dan sesi aktif diputus. Status billing tidak berubah.`, danger: true, confirmLabel: 'Isolir'})}>Isolir</Button>}
              {isAdmin && <Button variant="secondary" icon={RotateCcw} disabled={action.isPending || service.network_state !== 'isolated' || service.status !== 'active'}
                onClick={() => run('restore', 'Isolir dibuka')} title={service.status !== 'active' ? 'Aktifkan status billing terlebih dahulu' : undefined}>Buka isolir</Button>}
              <Button variant="ghost" icon={Eye} onClick={reveal}>Lihat kredensial</Button>
            </div>
            {credentials && (
              <div className="credentials">
                <span>Username <b className="mono">{credentials.pppoe_username}</b></span>
                <span>Password <b className="mono">{credentials.pppoe_password}</b></span>
                <button type="button" className="link-btn" onClick={() => { navigator.clipboard?.writeText(credentials.pppoe_password); toast('Password disalin'); }}><Copy size={13}/> Salin</button>
              </div>
            )}
            <p className="fineprint">Setiap aksi dan akses kredensial tercatat di log audit jaringan.</p>
          </section>
        )}
      </div>
    </Dialog>
  );
}
