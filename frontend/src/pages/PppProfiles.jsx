import React, {useMemo, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Plus} from 'lucide-react';
import {api} from '../api/client.js';
import {useApiMutation} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import RouterPicker, {useSelectedRouter} from '../components/RouterPicker.jsx';
import {Alert, Button, Dialog, Field, Figure, Figures, FormActions, PageHeader, QueryGate} from '../components/ui.jsx';
import {num} from '../lib/format.js';

export default function PppProfiles() {
  const picker = useSelectedRouter();
  const router = picker.selected;
  const profiles = useQuery({queryKey: ['routers', router?.id, 'profiles'], queryFn: () => api(`/routers/${router.id}/profiles`), enabled: Boolean(router), retry: false});
  const remove = useApiMutation();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);

  const destroy = async p => {
    if (!await confirm({title: 'Hapus profile?', body: `Profile “${p.name}” akan dihapus dari router ${router.name}.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: `/routers/${router.id}/profiles/${encodeURIComponent(p.id)}`, method: 'DELETE', success: 'Profile dihapus dari router'});
  };

  const columns = useMemo(() => [
    col('name', 'Nama', r => r.name, {cell: r => <><span className="mono strong">{r.name}</span>{r.builtin && <div className="sub">Bawaan RouterOS</div>}</>}),
    col('rate', 'Rate limit (up/down)', r => r.rate_limit, {cell: r => r.rate_limit ? <span className="mono">{r.rate_limit}</span> : <span className="faint">Tanpa batas</span>}),
    col('remote', 'Remote address / pool', r => r.remote_address),
    col('local', 'Local address', r => r.local_address),
    col('dns', 'DNS', r => r.dns_server, {hidden: true}),
    col('only_one', 'Only one', r => r.only_one, {hidden: true}),
    col('secrets', 'User', r => r.secrets, {align: 'num'}),
    col('used', 'Dipakai NexaISP', r => r.used_by.join(', '), {cell: r => r.used_by.length ? <span className="wrap">{r.used_by.join(', ')}</span> : <span className="faint">—</span>}),
    col('comment', 'Komentar', r => r.comment, {hidden: true}),
    actionsCol(r => <>
      <button type="button" className="link-btn" onClick={() => setDialog({profile: r})}>Edit</button>
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={r.builtin || r.secrets > 0 || r.used_by.length > 0}
        title={r.builtin ? 'Profile bawaan' : r.secrets ? `Dipakai ${r.secrets} user` : r.used_by.length ? 'Dipakai paket/isolir' : 'Hapus'}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [router?.id]);

  return (
    <>
      <PageHeader eyebrow="Konfigurasi · MikroTik" title="PPP Profile"
        description="Profile menentukan rate-limit, pool IP, dan DNS untuk user PPPoE. Data dibaca langsung dari router."
        actions={<Button icon={Plus} disabled={!router} onClick={() => setDialog({})}>Profile Baru</Button>}/>
      <RouterPicker state={picker}/>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      {router && (
        <QueryGate queries={[profiles]}>
          {() => <>
            <Figures cols={3}>
              <Figure label="Profile" value={num(profiles.data.length)} sub={router.name}/>
              <Figure tone="blue" label="Dengan rate-limit" value={num(profiles.data.filter(p => p.rate_limit).length)}/>
              <Figure tone="amber" label="Dipakai paket NexaISP" value={num(profiles.data.filter(p => p.used_by.length).length)} to="/catalog"/>
            </Figures>
            <DataTable id="ppp-profiles" syncUrl={false} data={profiles.data} columns={columns} exportName={'ppp-profile-' + router.name}
              searchPlaceholder="Cari nama profile, rate-limit, pool…" emptyTitle="Belum ada profile"/>
          </>}
        </QueryGate>
      )}
      {dialog && router && <ProfileForm router={router} profile={dialog.profile} onClose={() => setDialog(null)}/>}
    </>
  );
}

function ProfileForm({router, profile, onClose}) {
  const save = useApiMutation();
  const pools = useQuery({queryKey: ['routers', router.id, 'pools'], queryFn: () => api(`/routers/${router.id}/pools`), retry: false});
  const locked = profile && (profile.builtin || profile.used_by.length > 0);
  const [remote, setRemote] = useState(profile?.remote_address || '');
  const [local, setLocal] = useState(profile?.local_address || '');
  // Local address diisi otomatis dari pool selama belum diketik manual oleh admin.
  const [autoFrom, setAutoFrom] = useState(null);
  const manualLocal = useRef(Boolean(profile?.local_address));

  const pickRemote = value => {
    setRemote(value);
    const pool = (pools.data || []).find(p => p.name === value.trim());
    if (manualLocal.current) return;
    if (pool?.gateway) { setLocal(pool.gateway); setAutoFrom(pool); }
    else if (autoFrom) { setLocal(''); setAutoFrom(null); }
  };
  const localHint = autoFrom
    ? (autoFrom.gateway_source === 'interface' ? `Otomatis: IP interface router di subnet pool ${autoFrom.name}` : `Otomatis: IP sebelum awal range pool ${autoFrom.name} (${autoFrom.ranges})`)
    : 'Pilih pool untuk mengisi otomatis, atau ketik manual';

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      name: raw.name ?? profile.name, rate_limit: raw.rate_limit.trim() || null,
      remote_address: raw.remote_address.trim() || null, local_address: raw.local_address.trim() || null,
      dns_server: raw.dns_server.trim() || null, only_one: raw.only_one || null, comment: raw.comment.trim() || null,
    };
    save.mutate({
      path: profile ? `/routers/${router.id}/profiles/${encodeURIComponent(profile.id)}` : `/routers/${router.id}/profiles`,
      method: profile ? 'PUT' : 'POST', body, success: profile ? 'Profile diperbarui di router' : 'Profile dibuat di router',
    }, {onSuccess: onClose});
  };

  return (
    <Dialog title={(profile ? 'Edit Profile ' + profile.name : 'Profile Baru') + ' · ' + router.name} onClose={onClose} size="lg">
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <div className="grid-2">
          <Field label="Nama profile" name="name" required maxLength={80} pattern="[A-Za-z0-9._ \-]+" defaultValue={profile?.name || ''}
            disabled={locked} placeholder="paket-50m" hint={locked ? 'Tidak bisa diganti: profile bawaan atau dipakai NexaISP' : 'Dipakai di kolom PPP Profile pada Katalog Layanan'}/>
          <Field label="Rate limit (upload/download)" name="rate_limit" maxLength={120} pattern="[0-9A-Za-z\/ .:]*" defaultValue={profile?.rate_limit || ''}
            placeholder="20M/50M" hint="Format RouterOS rx/tx, mis. 10M/20M. Kosong = tanpa batas"/>
        </div>
        <div className="grid-2">
          <Field label="Remote address (pool atau IP)" name="remote_address" maxLength={100} list="ppp-pools" value={remote} onChange={e => pickRemote(e.target.value)} placeholder="pool-pppoe"/>
          <Field label="Local address (IP gateway)" name="local_address" maxLength={100} value={local} placeholder="10.20.0.1" hint={localHint}
            onChange={e => { setLocal(e.target.value); setAutoFrom(null); manualLocal.current = e.target.value !== ''; }}/>
          <datalist id="ppp-pools">{(pools.data || []).map(p => <option key={p.name} value={p.name}>{p.ranges}</option>)}</datalist>
        </div>
        <div className="grid-2">
          <Field label="DNS server" name="dns_server" maxLength={120} defaultValue={profile?.dns_server || ''} placeholder="8.8.8.8,1.1.1.1"/>
          <Field label="Only one" name="only_one" defaultValue={profile?.only_one || ''}>
            <option value="">Bawaan router</option>
            <option value="default">default</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </Field>
        </div>
        <Field label="Komentar" name="comment" maxLength={200} defaultValue={profile?.comment || ''}/>
        {pools.isError && <p className="fineprint">Daftar pool tidak dapat dimuat: {pools.error.message}</p>}
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={profile ? 'Simpan ke Router' : 'Buat di Router'}/>
      </form>
    </Dialog>
  );
}
