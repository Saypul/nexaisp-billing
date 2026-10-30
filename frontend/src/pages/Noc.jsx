import React, {useMemo, useState} from 'react';
import {LogOut, RefreshCw} from 'lucide-react';
import {useApiMutation, useRouters, useTickets} from '../api/hooks.js';
import {useNetworkResultToast} from '../forms/NetworkForm.jsx';
import {Brand} from '../components/Layout.jsx';
import DataTable, {col} from '../components/DataTable.jsx';
import TicketDetail from '../components/TicketDetail.jsx';
import {Alert, Button, Field, Figure, Figures, PageHeader, QueryGate, TicketBadge} from '../components/ui.jsx';
import {useAuth} from '../lib/auth.jsx';
import {categories, fmtDate, num, teamNames, ticketStatusNames, todayDate} from '../lib/format.js';

const facets = [
  {id: 'status', title: 'Progres', value: r => r.status, options: Object.entries(ticketStatusNames)},
  {id: 'category', title: 'Layanan', value: r => r.category, options: Object.entries(categories)},
];

function ActivationForm({ticket, onDone}) {
  const activate = useApiMutation();
  const routers = (useRouters().data || []).filter(r => r.enabled);
  const showResult = useNetworkResultToast();
  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {billing_start_date: raw.billing_start_date, notes: raw.notes};
    if (raw.router_id) Object.assign(body, {router_id: Number(raw.router_id), pppoe_username: raw.pppoe_username?.trim() || null});
    activate.mutate({path: `/tickets/${ticket.id}/activate`, body, success: 'Layanan diaktifkan dan ticket Closed'}, {onSuccess: data => { showResult(data.network_result); onDone(); }});
  };
  return (
    <form className="activation" onSubmit={submit}>
      <h3>Verifikasi & aktivasi</h3>
      <Alert tone="error">{activate.error?.message}</Alert>
      <Alert>Aktivasi dapat dilakukan saat RFS target tiba. Tanggal mulai billing boleh sama atau setelah tanggal aktivasi.</Alert>
      <Field label="Tanggal Mulai Billing" name="billing_start_date" type="date" min={todayDate()} defaultValue={todayDate()} required/>
      {routers.length > 0 && (
        <div className="grid-2">
          <Field label="Router PPPoE" name="router_id" defaultValue="" hint="Opsional. Secret PPPoE dibuat otomatis setelah aktivasi.">
            <option value="">Tanpa provisioning</option>
            {routers.map(r => <option key={r.id} value={r.id}>{r.name} · {r.host}</option>)}
          </Field>
          <Field label="Username PPPoE" name="pppoe_username" maxLength={100} pattern="[A-Za-z0-9._@\-]*" placeholder={(ticket.service_code || '').toLowerCase()} hint="Kosong = Service ID"/>
        </div>
      )}
      <Field label="Catatan Verifikasi NOC" name="notes" as="textarea" required minLength={3} maxLength={2000} placeholder="Contoh: link up, konfigurasi dan pengujian selesai"/>
      <Button type="submit" disabled={activate.isPending}>{activate.isPending ? 'Mengaktifkan…' : 'Aktifkan Layanan & Closed'}</Button>
    </form>
  );
}

export default function Noc() {
  const {session, logout} = useAuth();
  const tickets = useTickets({refetchInterval: 30_000});
  const [selected, setSelected] = useState(null);

  const columns = useMemo(() => [
    col('wo', 'WO', r => r.work_order_code, {cell: r => <span className="mono strong">{r.work_order_code}</span>}),
    col('customer', 'Pelanggan', r => r.customer_name),
    col('service', 'Layanan', r => r.service_code, {cell: r => <>{r.service_code || '—'}<div className="sub">{r.plan_name || 'Belum dipilih'}</div></>}),
    col('team', 'Tim', r => teamNames[r.work_order_team]),
    col('rfs', 'RFS Target', r => r.rfs_target_date, {cell: r => fmtDate(r.rfs_target_date)}),
    col('status', 'Progres', r => r.status, {cell: r => <TicketBadge status={r.status} team={r.work_order_team}/>}),
  ], []);

  const ticket = selected && tickets.data?.find(t => t.id === selected);
  return (
    <div className="noc">
      <header className="noc-head">
        <Brand/>
        <span className="who"><span>{session.email}</span><small>NOC</small></span>
        <Button variant="secondary" icon={RefreshCw} className="small" onClick={() => tickets.refetch()} disabled={tickets.isFetching}>Muat ulang</Button>
        <Button variant="ghost" icon={LogOut} className="small" onClick={() => logout()}>Keluar</Button>
      </header>
      <main className="main" id="main">
        <PageHeader eyebrow="Network Operations Center" title="Antrean Aktivasi" description="Verifikasi instalasi, RFS, dan layanan sebelum billing dimulai."/>
        <QueryGate queries={[tickets]}>
          {() => <>
            <Figures cols={3}>
              <Figure label="Siap aktivasi" value={num(tickets.data.filter(t => t.status === 'ready').length)} sub="Menunggu verifikasi NOC" to="/?status=ready"/>
              <Figure label="Terjadwal RFS" value={num(tickets.data.filter(t => t.status === 'scheduled').length)} sub="Belum masuk WO teknisi"/>
              <Figure label="Aktif" value={num(tickets.data.filter(t => t.status === 'closed').length)} sub="Ditutup setelah aktivasi"/>
            </Figures>
            <DataTable id="noc" data={tickets.data} columns={columns} facets={facets}
              searchText={r => [r.work_order_code, r.code, r.customer_name, r.service_code, r.circuit_id].join(' ')}
              searchPlaceholder="Cari WO, pelanggan, service ID…"
              onRowClick={r => setSelected(r.id)} rowLabel={r => 'Verifikasi ' + r.work_order_code}
              emptyTitle="Belum ada work order"/>
          </>}
        </QueryGate>
      </main>
      {ticket && <TicketDetail ticket={ticket} onClose={() => setSelected(null)} actions={ticket.status === 'ready' && <ActivationForm ticket={ticket} onDone={() => setSelected(null)}/>}/>}
    </div>
  );
}
