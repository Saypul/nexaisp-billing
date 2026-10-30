import React, {useMemo, useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {Plus, Router as RouterIcon, ShieldOff, TriangleAlert, Wifi} from 'lucide-react';
import {api} from '../api/client.js';
import {useApiMutation, useAutoIsolatePreview, useNetworkEvents, useNetworkSettings, useRouters, useSubscriptions} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm, useToast} from '../components/feedback.jsx';
import {Alert, Button, Checkbox, Dialog, Empty, Field, Figure, Figures, FormActions, Loading, PageHeader, QueryGate, Section} from '../components/ui.jsx';
import {fmtDateTime, networkActionNames, num} from '../lib/format.js';

export default function Network() {
  const routers = useRouters();
  const subs = useSubscriptions();
  const [dialog, setDialog] = useState(null);
  const services = subs.data || [];

  return (
    <>
      <PageHeader eyebrow="Integrasi · MikroTik RouterOS API" title="Network & RADIUS"
        description="Router PPPoE, provisioning secret, isolir manual dan otomatis. Status billing tetap menjadi acuan; kegagalan router dicatat tanpa membatalkan transaksi billing."
        actions={<Button icon={Plus} onClick={() => setDialog({type: 'router'})}>Tambah Router</Button>}/>
      <Figures cols={4}>
        <Figure icon={RouterIcon} label="Router" value={num(routers.data?.length)} sub={`${num(routers.data?.filter(r => r.last_error).length)} bermasalah`}/>
        <Figure icon={Wifi} tone="blue" label="Layanan terpetakan" value={num(services.filter(s => s.router_id).length)} sub={`dari ${num(services.length)} layanan`} to="/services?network=provisioned"/>
        <Figure icon={ShieldOff} tone="amber" label="Diisolir" value={num(services.filter(s => s.network_state === 'isolated').length)} to="/services?network=isolated"/>
        <Figure icon={TriangleAlert} label="Gagal sinkron" value={num(services.filter(s => s.network_state === 'error').length)} tone={services.some(s => s.network_state === 'error') ? 'risk' : ''} to="/services?network=error"/>
      </Figures>
      <QueryGate queries={[routers]}>
        {() => <Routers routers={routers.data} setDialog={setDialog}/>}
      </QueryGate>
      <Policy/>
      <Events/>
      {dialog?.type === 'router' && <RouterForm router={dialog.router} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'sessions' && <Sessions router={dialog.router} onClose={() => setDialog(null)}/>}
    </>
  );
}

function Routers({routers, setDialog}) {
  const test = useApiMutation();
  const remove = useApiMutation();
  const confirm = useConfirm();
  const toast = useToast();
  const [testing, setTesting] = useState(null);

  const runTest = r => {
    setTesting(r.id);
    test.mutate({path: `/routers/${r.id}/test`}, {
      onSuccess: res => toast(res.ok ? `${res.identity} · RouterOS ${res.version} · CPU ${res.cpu_load}% · ${res.active_sessions} sesi PPP` : 'Gagal: ' + res.error, res.ok ? 'ok' : 'error'),
      onSettled: () => setTesting(null),
    });
  };
  const destroy = async r => {
    if (!await confirm({title: 'Hapus router?', body: `${r.name} (${r.host}) akan dihapus dari NexaISP. Konfigurasi di router tidak diubah.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/routers/' + r.id, method: 'DELETE', success: 'Router dihapus'});
  };

  const columns = useMemo(() => [
    col('name', 'Router', r => r.name, {cell: r => <><span className="strong">{r.name}</span><div className="sub">{r.identity ? `${r.identity} · RouterOS ${r.version}` : 'Belum dites'}</div></>}),
    col('host', 'Alamat API', r => `${r.host}:${r.port}`, {cell: r => <span className="mono">{r.host}:{r.port}{r.use_tls ? ' (TLS)' : ''}</span>}),
    col('isolation', 'Mode isolir', r => (r.isolation_mode === 'profile' ? 'Profile ' + r.isolation_profile : 'Disable secret')),
    col('services', 'Layanan', r => r.services, {align: 'num'}),
    col('status', 'Status', r => (!r.enabled ? 'Nonaktif' : r.last_error ? 'Error' : r.last_checked_at ? 'OK' : 'Belum dites'), {
      cell: r => !r.enabled ? <span className="mark mark-muted"><i/>Nonaktif</span>
        : r.last_error ? <span className="mark mark-overdue" title={r.last_error}><i/>Error</span>
        : r.last_checked_at ? <span className="mark mark-paid"><i/>OK · {fmtDateTime(r.last_checked_at)}</span>
        : <span className="mark mark-muted"><i/>Belum dites</span>,
    }),
    actionsCol(r => <>
      <button type="button" className="link-btn" onClick={() => runTest(r)} disabled={testing === r.id}>{testing === r.id ? 'Menguji…' : 'Tes'}</button>
      <button type="button" className="link-btn" onClick={() => setDialog({type: 'sessions', router: r})}>Sesi aktif</button>
      <button type="button" className="link-btn" onClick={() => setDialog({type: 'router', router: r})}>Edit</button>
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={r.services > 0} title={r.services ? 'Masih dipakai layanan' : 'Hapus'}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [testing]);

  return (
    <Section title="Router MikroTik" sub="Koneksi lewat RouterOS API (8728, atau 8729 dengan TLS). Disarankan user API khusus dengan grup terbatas: read, write, api, test." flush>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      {routers.find(r => r.last_error) && <Alert tone="error">{routers.filter(r => r.last_error).map(r => `${r.name}: ${r.last_error}`).join(' · ')}</Alert>}
      <DataTable id="routers" syncUrl={false} data={routers} columns={columns} searchPlaceholder="Cari router…"
        emptyTitle="Belum ada router" emptyDesc="Tambahkan router MikroTik, lalu uji koneksi sebelum memetakan layanan."/>
    </Section>
  );
}

function RouterForm({router, onClose}) {
  const save = useApiMutation();
  const [mode, setMode] = useState(router?.isolation_mode || 'disable');
  const profiles = useQuery({queryKey: ['routers', router?.id, 'profiles'], queryFn: () => api(`/routers/${router.id}/profiles`), enabled: Boolean(router), retry: false});

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      name: raw.name, host: raw.host.trim(), port: Number(raw.port), username: raw.username,
      use_tls: raw.use_tls === 'on', tls_verify: raw.tls_verify === 'on', enabled: raw.enabled === 'on',
      isolation_mode: raw.isolation_mode, isolation_profile: raw.isolation_profile || null,
      password: raw.password || (router ? null : ''),
    };
    save.mutate({path: router ? '/routers/' + router.id : '/routers', method: router ? 'PUT' : 'POST', body, success: router ? 'Router diperbarui' : 'Router ditambahkan'}, {onSuccess: onClose});
  };

  return (
    <Dialog title={router ? 'Edit Router ' + router.name : 'Tambah Router'} onClose={onClose} size="lg">
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <div className="grid-2">
          <Field label="Nama" name="name" required minLength={2} maxLength={100} defaultValue={router?.name || ''} placeholder="BRAS-JKT-01"/>
          <Field label="Host / IP" name="host" required maxLength={255} defaultValue={router?.host || ''} placeholder="10.10.0.1"/>
        </div>
        <div className="grid-3">
          <Field label="Port API" name="port" type="number" min="1" max="65535" required defaultValue={router?.port || 8728} hint="8728 biasa · 8729 TLS"/>
          <Field label="Username API" name="username" required maxLength={100} defaultValue={router?.username || ''} autoComplete="off"/>
          <Field label="Password API" name="password" type="password" required={!router} maxLength={200} autoComplete="new-password" placeholder={router ? 'Kosongkan = tetap' : ''}/>
        </div>
        <div className="grid-3">
          <Checkbox name="use_tls" defaultChecked={router?.use_tls} label="Gunakan TLS (api-ssl)"/>
          <Checkbox name="tls_verify" defaultChecked={router?.tls_verify} label="Verifikasi sertifikat" hint="Matikan untuk sertifikat self-signed"/>
          <Checkbox name="enabled" defaultChecked={router ? router.enabled : true} label="Aktif" hint="Nonaktif = tidak ada perintah dikirim"/>
        </div>
        <div className="grid-2">
          <Field label="Cara isolir" name="isolation_mode" value={mode} onChange={e => setMode(e.target.value)}>
            <option value="disable">Disable PPP secret + putus sesi</option>
            <option value="profile">Pindah ke PPP profile isolir + putus sesi</option>
          </Field>
          <Field label="PPP profile isolir" name="isolation_profile" defaultValue={router?.isolation_profile || ''} required={mode === 'profile'} disabled={mode !== 'profile'}
            list="router-profiles" placeholder="isolir" hint="Profile ini biasanya mengarahkan pelanggan ke halaman pemberitahuan tagihan"/>
          <datalist id="router-profiles">{(profiles.data || []).map(p => <option key={p.name} value={p.name}>{p.rate_limit || ''}</option>)}</datalist>
        </div>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={router ? 'Simpan Perubahan' : 'Tambah Router'}/>
      </form>
    </Dialog>
  );
}

function Sessions({router, onClose}) {
  const sessions = useQuery({queryKey: ['routers', router.id, 'sessions'], queryFn: () => api(`/routers/${router.id}/sessions`), retry: false, refetchInterval: 30_000});
  const columns = useMemo(() => [
    col('name', 'Username', r => r.name, {cell: r => <span className="mono strong">{r.name}</span>}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => (r.customer_id ? <Link to={'/customers/' + r.customer_id + '?tab=services'}>{r.customer_name}</Link> : <span className="faint">Tidak terpetakan</span>)}),
    col('service', 'Service ID', r => r.service_code),
    col('address', 'IP', r => r.address, {cell: r => <span className="mono">{r.address || '—'}</span>}),
    col('caller', 'Caller ID (MAC)', r => r.caller_id, {cell: r => <span className="mono">{r.caller_id || '—'}</span>}),
    col('uptime', 'Uptime', r => r.uptime),
  ], []);
  return (
    <Dialog title={'Sesi PPP aktif · ' + router.name} onClose={onClose} size="lg">
      <div className="dialog-body">
        {sessions.isPending ? <Loading label="Menghubungi router…"/> : sessions.isError ? <Alert tone="error">{sessions.error.message}</Alert> : (
          <DataTable id="sessions" syncUrl={false} data={sessions.data.map((s, i) => ({...s, id: s.name + i}))} columns={columns} exportName={'sesi-' + router.name}
            facets={[{id: 'mapped', title: 'Pemetaan', value: r => (r.subscription_id ? 'yes' : 'no'), options: [['yes', 'Terpetakan'], ['no', 'Tidak terpetakan']]}]}
            searchPlaceholder="Cari username, IP, MAC, pelanggan…" emptyTitle="Tidak ada sesi PPP aktif"/>
        )}
      </div>
    </Dialog>
  );
}

function Policy() {
  const settings = useNetworkSettings();
  const preview = useAutoIsolatePreview();
  const save = useApiMutation();
  const confirm = useConfirm();

  const submit = async e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {auto_isolate: raw.auto_isolate === 'on', grace_days: Number(raw.grace_days), auto_restore: raw.auto_restore === 'on', max_per_run: Number(raw.max_per_run)};
    if (body.auto_isolate && !settings.data.auto_isolate) {
      const ok = await confirm({
        title: 'Aktifkan isolir otomatis?',
        body: `Setiap jam sistem akan mengisolir layanan PPPoE milik pelanggan dengan invoice belum lunas lebih dari ${body.grace_days} hari setelah jatuh tempo, maksimal ${body.max_per_run} layanan per putaran. Periksa daftar pratinjau sebelum mengaktifkan.`,
        danger: true, confirmLabel: 'Aktifkan',
      });
      if (!ok) return;
    }
    save.mutate({path: '/network/settings', method: 'PUT', body, success: 'Kebijakan isolir tersimpan'});
  };

  return (
    <Section title="Isolir otomatis karena tunggakan" sub="Berjalan setiap jam bersama penerbitan invoice otomatis. Hanya layanan aktif yang sudah dipetakan ke router.">
      <QueryGate queries={[settings]}>
        {() => {
          const s = settings.data;
          const p = preview.data;
          return (
            <div className="split">
              <form onSubmit={submit} key={JSON.stringify(s)}>
                <Alert tone="error">{save.error?.message}</Alert>
                {s.auto_isolate ? <Alert tone="error">Isolir otomatis <b>AKTIF</b>.</Alert> : <Alert>Isolir otomatis nonaktif. Isolir hanya terjadi saat admin mengubah status layanan.</Alert>}
                <Checkbox name="auto_isolate" defaultChecked={s.auto_isolate} label="Isolir otomatis layanan yang menunggak"/>
                <Checkbox name="auto_restore" defaultChecked={s.auto_restore} label="Buka isolir otomatis setelah lunas" hint="Langsung saat pembayaran melunasi invoice, dan dicek ulang setiap jam"/>
                <div className="grid-2">
                  <Field label="Toleransi setelah jatuh tempo (hari)" name="grace_days" type="number" min="0" max="90" required defaultValue={s.grace_days}/>
                  <Field label="Maksimal isolir per putaran" name="max_per_run" type="number" min="1" max="1000" required defaultValue={s.max_per_run} hint="Rem pengaman bila ada kesalahan data"/>
                </div>
                <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Menyimpan…' : 'Simpan Kebijakan'}</Button>
              </form>
              <div>
                <h3 className="subhead">Pratinjau putaran berikutnya</h3>
                {!p ? <Loading/> : (
                  <>
                    <p className="fineprint">Berdasarkan toleransi tersimpan ({p.settings.grace_days} hari){p.settings.auto_isolate ? '' : '. Isolir tidak dijalankan selama kebijakan nonaktif'}.</p>
                    <table className="mini">
                      <thead><tr><th>Akan diisolir ({num(p.isolate_total)})</th><th>Router</th></tr></thead>
                      <tbody>
                        {p.isolate.length ? p.isolate.slice(0, 8).map(r => <tr key={r.subscription_id}><td><Link to={`/customers/${r.customer_id}?tab=invoices`}>{r.customer_name}</Link><div className="sub mono">{r.pppoe_username}</div></td><td>{r.router_name}</td></tr>)
                          : <tr><td colSpan={2} className="faint">Tidak ada</td></tr>}
                      </tbody>
                    </table>
                    {p.isolate_total > p.isolate.length && <p className="fineprint">{p.isolate_total - p.isolate.length} lainnya menunggu putaran berikutnya (batas per putaran).</p>}
                    <table className="mini">
                      <thead><tr><th>Akan dipulihkan ({num(p.restore.length)})</th><th>Router</th></tr></thead>
                      <tbody>
                        {p.restore.length ? p.restore.slice(0, 8).map(r => <tr key={r.subscription_id}><td>{r.customer_name}<div className="sub mono">{r.pppoe_username}</div></td><td>{r.router_name}</td></tr>)
                          : <tr><td colSpan={2} className="faint">Tidak ada</td></tr>}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            </div>
          );
        }}
      </QueryGate>
    </Section>
  );
}

const eventFacets = [
  {id: 'action', title: 'Aksi', value: r => r.action, options: Object.entries(networkActionNames)},
  {id: 'result', title: 'Hasil', value: r => (r.ok ? 'ok' : 'fail'), options: [['ok', 'Berhasil'], ['fail', 'Gagal']]},
];

function Events() {
  const events = useNetworkEvents();
  const columns = useMemo(() => [
    col('time', 'Waktu', r => r.created_at, {cell: r => fmtDateTime(r.created_at)}),
    col('action', 'Aksi', r => networkActionNames[r.action] || r.action),
    col('result', 'Hasil', r => (r.ok ? 'Berhasil' : 'Gagal'), {cell: r => <span className={'mark ' + (r.ok ? 'mark-paid' : 'mark-overdue')}><i/>{r.ok ? 'Berhasil' : 'Gagal'}</span>}),
    col('router', 'Router', r => r.router_name),
    col('service', 'Layanan', r => r.service_code, {cell: r => (r.customer_id ? <Link to={`/customers/${r.customer_id}?tab=services`} className="mono">{r.service_code}</Link> : '—')}),
    col('message', 'Keterangan', r => r.message, {cell: r => <span className="wrap">{r.message || '—'}</span>}),
    col('actor', 'Oleh', r => r.actor),
  ], []);
  return (
    <Section title="Log audit jaringan" sub="500 aksi terakhir ke router, termasuk yang gagal dan akses kredensial" flush>
      <QueryGate queries={[events]}>
        {() => events.data.length ? <DataTable id="network-events" syncUrl={false} data={events.data} columns={columns} facets={eventFacets} exportName="audit-jaringan"
          searchPlaceholder="Cari router, layanan, keterangan, pengguna…" initialSort={[{id: 'time', desc: true}]}/> : <Empty title="Belum ada aktivitas jaringan"/>}
      </QueryGate>
    </Section>
  );
}
