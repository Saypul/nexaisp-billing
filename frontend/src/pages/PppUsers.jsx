import React, {useMemo, useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {Copy, Plus} from 'lucide-react';
import {api} from '../api/client.js';
import {useApiMutation, useSubscriptions} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm, useToast} from '../components/feedback.jsx';
import RouterPicker, {useSelectedRouter} from '../components/RouterPicker.jsx';
import {Alert, Button, Checkbox, Dialog, Field, Figure, Figures, FormActions, PageHeader, QueryGate} from '../components/ui.jsx';
import {num} from '../lib/format.js';

const userState = r => (r.disabled ? 'disabled' : r.online ? 'online' : 'offline');
const stateMark = {online: ['mark-paid', 'Online'], offline: ['mark-muted', 'Offline'], disabled: ['mark-overdue', 'Disabled']};

export default function PppUsers() {
  const picker = useSelectedRouter();
  const router = picker.selected;
  const enabled = Boolean(router);
  const secrets = useQuery({queryKey: ['routers', router?.id, 'secrets'], queryFn: () => api(`/routers/${router.id}/secrets`), enabled, retry: false, refetchInterval: 60_000});
  const profiles = useQuery({queryKey: ['routers', router?.id, 'profiles'], queryFn: () => api(`/routers/${router.id}/profiles`), enabled, retry: false});
  const mutate = useApiMutation();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);

  const destroy = async r => {
    if (!await confirm({title: 'Hapus user PPP?', body: `User “${r.name}” akan dihapus dari router ${router.name} dan sesi aktifnya diputus.`, danger: true, confirmLabel: 'Hapus'})) return;
    mutate.mutate({path: `/routers/${router.id}/secrets/${encodeURIComponent(r.id)}`, method: 'DELETE', success: 'User dihapus dari router'});
  };
  const kick = async r => {
    if (!await confirm({title: 'Putus sesi?', body: `Sesi aktif “${r.name}” akan diputus; perangkat pelanggan biasanya langsung login ulang.`, confirmLabel: 'Putus Sesi'})) return;
    mutate.mutate({path: `/routers/${router.id}/secrets/${encodeURIComponent(r.id)}/disconnect`, success: 'Sesi diputus'});
  };

  const facets = useMemo(() => [
    {id: 'state', title: 'Status', value: userState, options: [['online', 'Online'], ['offline', 'Offline'], ['disabled', 'Disabled']]},
    {id: 'profile', title: 'Profile', value: r => r.profile},
    {id: 'managed', title: 'Pemilik', value: r => (r.subscription_id ? 'nexaisp' : 'manual'), options: [['nexaisp', 'Layanan NexaISP'], ['manual', 'Manual / lainnya']]},
  ], []);

  const columns = useMemo(() => [
    col('name', 'Username', r => r.name, {cell: r => <span className="mono strong">{r.name}</span>}),
    col('state', 'Status', r => stateMark[userState(r)][1], {cell: r => { const [cls, label] = stateMark[userState(r)]; return <span className={'mark ' + cls}><i/>{label}{r.online ? ' · ' + r.uptime : ''}</span>; }}),
    col('profile', 'Profile', r => r.profile, {cell: r => <span className="mono">{r.profile || 'default'}</span>}),
    col('service', 'Service', r => r.service),
    col('ip', 'IP', r => r.address || r.remote_address, {cell: r => <span className="mono">{r.address || r.remote_address || '—'}</span>}),
    col('customer', 'Layanan NexaISP', r => r.customer_name, {cell: r => (r.subscription_id ? <><Link to={`/customers/${r.customer_id}?tab=services`}>{r.customer_name}</Link><div className="sub mono">{r.service_code}</div></> : <span className="faint">—</span>)}),
    col('caller', 'Caller ID', r => r.caller_id, {hidden: true}),
    col('logout', 'Terakhir logout', r => r.last_logged_out, {hidden: true}),
    col('comment', 'Komentar', r => r.comment, {cell: r => <span className="wrap">{r.comment || '—'}</span>}),
    actionsCol(r => <>
      <button type="button" className="link-btn" onClick={() => setDialog({secret: r})}>Edit</button>
      {r.online && <button type="button" className="link-btn" onClick={() => kick(r)}>Putus</button>}
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={Boolean(r.subscription_id)} title={r.subscription_id ? 'Terhubung ke layanan NexaISP' : 'Hapus'}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [router?.id]);

  return (
    <>
      <PageHeader eyebrow="Konfigurasi · MikroTik" title="PPP User"
        description="Akun PPPoE (PPP secret) di router. User yang terhubung ke layanan NexaISP mengikuti profile paket dan status billing."
        actions={<Button icon={Plus} disabled={!router} onClick={() => setDialog({})}>User Baru</Button>}/>
      <RouterPicker state={picker}/>
      <Alert tone="error" onDismiss={mutate.reset}>{mutate.error?.message}</Alert>
      {router && (
        <QueryGate queries={[secrets]}>
          {() => {
            const rows = secrets.data;
            return <>
              <Figures cols={4}>
                <Figure label="User PPP" value={num(rows.length)} sub={router.name}/>
                <Figure tone="blue" label="Online" value={num(rows.filter(r => r.online).length)}/>
                <Figure label="Disabled" value={num(rows.filter(r => r.disabled).length)} tone={rows.some(r => r.disabled) ? 'risk' : ''}/>
                <Figure tone="purple" label="Terhubung layanan" value={num(rows.filter(r => r.subscription_id).length)} sub={`${num(rows.filter(r => !r.subscription_id).length)} manual`}/>
              </Figures>
              <DataTable id="ppp-users" syncUrl={false} data={rows} columns={columns} facets={facets} exportName={'ppp-user-' + router.name}
                searchText={r => [r.name, r.profile, r.address, r.remote_address, r.caller_id, r.customer_name, r.service_code, r.comment].join(' ')}
                searchPlaceholder="Cari username, IP, MAC, pelanggan, komentar…" initialSort={[{id: 'name', desc: false}]}
                emptyTitle="Belum ada user PPP" emptyDesc="Buat user baru atau petakan layanan dari menu Layanan Aktif."/>
            </>;
          }}
        </QueryGate>
      )}
      {dialog && router && <UserForm router={router} secret={dialog.secret} profiles={profiles.data || []} onClose={() => setDialog(null)}/>}
    </>
  );
}

function UserForm({router, secret, profiles, onClose}) {
  const save = useApiMutation();
  const toast = useToast();
  const services = (useSubscriptions().data || []).filter(s => !s.router_id && s.status !== 'terminated');
  const [linkId, setLinkId] = useState('');
  const [created, setCreated] = useState(null);
  const linked = Boolean(secret?.subscription_id || linkId);
  const linkedService = services.find(s => String(s.id) === linkId);

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      name: raw.name.trim(), password: raw.password || null, service: raw.service || 'pppoe',
      profile: raw.profile ?? secret?.profile ?? null, disabled: raw.disabled === 'on' || (secret?.subscription_id ? secret.disabled : false),
      remote_address: raw.remote_address.trim() || null, local_address: raw.local_address.trim() || null,
      comment: raw.comment.trim() || null, subscription_id: secret ? null : (linkId ? Number(linkId) : null),
    };
    if (secret?.subscription_id) body.disabled = secret.disabled;
    save.mutate({
      path: secret ? `/routers/${router.id}/secrets/${encodeURIComponent(secret.id)}` : `/routers/${router.id}/secrets`,
      method: secret ? 'PUT' : 'POST', body, success: secret ? 'User diperbarui di router' : 'User dibuat di router',
    }, {onSuccess: data => (data?.password ? setCreated({name: body.name, password: data.password}) : onClose())});
  };

  if (created) {
    return (
      <Dialog title="User PPP dibuat" onClose={onClose} size="sm">
        <div className="dialog-body">
          <p className="confirm-text">Password dibuat otomatis. Simpan sekarang; daftar user tidak menampilkan password.</p>
          <div className="credentials">
            <span>Username <b className="mono">{created.name}</b></span>
            <span>Password <b className="mono">{created.password}</b></span>
            <button type="button" className="link-btn" onClick={() => { navigator.clipboard?.writeText(created.password); toast('Password disalin'); }}><Copy size={13}/> Salin</button>
          </div>
          <div className="dialog-actions"><Button onClick={onClose}>Selesai</Button></div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={(secret ? 'Edit User ' + secret.name : 'User PPP Baru') + ' · ' + router.name} onClose={onClose} size="lg">
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        {secret?.subscription_id && <Alert>Terhubung ke layanan {secret.service_code} ({secret.customer_name}). Profile mengikuti paket dan aktif/nonaktif mengikuti status billing; ubah keduanya lewat menu Layanan.</Alert>}
        {!secret && (
          <Field label="Hubungkan ke layanan NexaISP (opsional)" name="link" value={linkId} onChange={e => setLinkId(e.target.value)}
            hint="Bila dipilih, user dipetakan ke layanan: profile mengikuti paket dan isolir mengikuti billing.">
            <option value="">Tidak dihubungkan (user manual)</option>
            {services.map(s => <option key={s.id} value={s.id}>{s.customer_name} · {s.code} · {s.plan_name}</option>)}
          </Field>
        )}
        <div className="grid-2">
          <Field label="Username" name="name" required maxLength={100} pattern="[A-Za-z0-9._@\-]+" defaultValue={secret?.name || ''}
            placeholder={linkedService ? linkedService.code.toLowerCase() : 'nama.pelanggan'} key={linkId}/>
          <Field label="Password" name="password" type="password" autoComplete="new-password" maxLength={100}
            placeholder={secret ? 'Kosongkan = password lama tetap' : 'Kosongkan = dibuat otomatis'}/>
        </div>
        <div className="grid-2">
          <Field label="Profile" name="profile" defaultValue={secret?.profile || 'default'} disabled={linked}
            hint={linked ? 'Mengikuti PPP Profile paket layanan' : undefined}>
            {profiles.map(p => <option key={p.id} value={p.name}>{p.name}{p.rate_limit ? ` · ${p.rate_limit}` : ''}</option>)}
          </Field>
          <Field label="Service" name="service" defaultValue={secret?.service || 'pppoe'}>
            {['pppoe', 'any', 'pptp', 'l2tp', 'sstp', 'ovpn'].map(s => <option key={s} value={s}>{s}</option>)}
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Remote address (IP statis pelanggan)" name="remote_address" maxLength={100} defaultValue={secret?.remote_address || ''} placeholder="Kosong = dari pool profile"/>
          <Field label="Local address" name="local_address" maxLength={100} defaultValue={secret?.local_address || ''} placeholder="Kosong = dari profile"/>
        </div>
        <Field label="Komentar" name="comment" maxLength={200} defaultValue={secret?.comment || ''}/>
        {!linked && <Checkbox name="disabled" defaultChecked={secret?.disabled} label="Disabled" hint="User tidak bisa login"/>}
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={secret ? 'Simpan ke Router' : 'Buat di Router'}/>
      </form>
    </Dialog>
  );
}
