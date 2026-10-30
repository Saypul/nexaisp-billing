import React, {useMemo, useState} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import {ClipboardList} from 'lucide-react';
import {api} from '../api/client.js';
import {useApiMutation, useBulkAction, useInvoices, useSubscriptions, useTickets} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import {Alert, Button, Figure, Figures, NetworkStatus, PageHeader, QueryGate, ServiceStatus} from '../components/ui.jsx';
import NetworkForm from '../forms/NetworkForm.jsx';
import ServiceForm from '../forms/ServiceForm.jsx';
import {activatedServices, invoicedServiceIds} from '../lib/billing.js';
import {billingNames, categories, fmtDate, idr, invoiceModeNames, networkStateNames, num, serviceStatusNames} from '../lib/format.js';

const facets = [
  {id: 'status', title: 'Status', value: r => r.status, options: Object.entries(serviceStatusNames).filter(([v]) => v !== 'pending')},
  {id: 'category', title: 'Layanan', value: r => r.category, options: Object.entries(categories)},
  {id: 'billing', title: 'Billing', value: r => r.billing_type, options: Object.entries(billingNames)},
  {id: 'mode', title: 'Invoice', value: r => r.invoice_mode, options: Object.entries(invoiceModeNames)},
  {id: 'network', title: 'Jaringan', value: r => r.network_state || 'unconfigured', options: Object.entries(networkStateNames)},
];

export default function Services() {
  const subs = useSubscriptions();
  const tickets = useTickets();
  const invoices = useInvoices();
  const navigate = useNavigate();
  const remove = useApiMutation();
  const bulk = useBulkAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const [networking, setNetworking] = useState(null);

  const ticketed = useMemo(() => new Set((tickets.data || []).map(t => t.subscription_id)), [tickets.data]);
  const invoiced = useMemo(() => invoicedServiceIds(invoices.data || []), [invoices.data]);

  const destroy = async s => {
    if (!await confirm({title: 'Hapus layanan?', body: `${s.code} milik ${s.customer_name} akan dihapus permanen.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/subscriptions/' + s.id, method: 'DELETE', success: 'Layanan dihapus'});
  };

  const setStatus = async (rows, status, clear) => {
    const ok = await confirm({
      title: `Ubah ${rows.length} layanan menjadi ${serviceStatusNames[status]}?`,
      body: 'Status hanya memengaruhi billing (layanan aktif masuk MRR dan invoice). Konfigurasi router/RADIUS tidak diubah.',
      confirmLabel: 'Ubah Status', danger: status !== 'active',
    });
    if (!ok) return;
    bulk.mutate({items: rows, label: 'layanan diperbarui', run: async s => {
      const res = await api(`/subscriptions/${s.id}/status`, {method: 'PATCH', body: {status}});
      // Status billing sudah tersimpan; laporkan bila sinkron router gagal.
      if (res.network_result && !res.network_result.ok && !res.network_result.skipped) throw new Error(`${s.code}: status tersimpan, router gagal (${res.network_result.error})`);
    }}, {onSuccess: clear});
  };

  const columns = useMemo(() => [
    col('code', 'Service ID', r => r.code, {cell: r => <span className="mono strong">{r.code}</span>}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <Link to={'/customers/' + r.customer_id + '?tab=services'} onClick={e => e.stopPropagation()}>{r.customer_name}</Link>}),
    col('plan', 'Produk', r => r.plan_name, {cell: r => <>{r.plan_name}<div className="sub">{categories[r.category]}</div></>}),
    col('bw', 'Bandwidth', r => r.bandwidth_mbps || 0, {align: 'num', cell: r => (r.bandwidth_mbps ? num(r.bandwidth_mbps) + ' Mbps' : 'Custom')}),
    col('billing', 'Billing', r => billingNames[r.billing_type]),
    col('mode', 'Invoice', r => invoiceModeNames[r.invoice_mode]),
    col('mrc', 'MRC', r => r.monthly_fee, {align: 'num', cell: r => idr(r.monthly_fee)}),
    col('otc', 'OTC', r => r.setup_fee, {align: 'num', cell: r => idr(r.setup_fee), hidden: true}),
    col('start', 'Mulai', r => r.start_date, {cell: r => fmtDate(r.start_date)}),
    col('circuit', 'Circuit ID', r => r.circuit_id, {cell: r => r.circuit_id ? <span className="mono">{r.circuit_id}</span> : '—'}),
    col('address', 'Alamat Layanan', r => r.service_address, {hidden: true}),
    col('status', 'Status', r => r.status, {cell: r => <ServiceStatus status={r.status}/>}),
    col('network', 'Jaringan', r => networkStateNames[r.network_state] || '', {cell: r => <span title={r.network_error || (r.pppoe_username ? `${r.pppoe_username} @ ${r.router_name}` : '')}><NetworkStatus state={r.network_state} reason={r.isolation_reason}/></span>}),
    col('pppoe', 'Username PPPoE', r => r.pppoe_username, {hidden: true}),
    col('router', 'Router', r => r.router_name, {hidden: true}),
    actionsCol(r => <>
      <button type="button" className="link-btn" onClick={() => setNetworking(r.id)}>Jaringan</button>
      <button type="button" className="link-btn" onClick={() => setEditing(r)}>Edit</button>
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={ticketed.has(r.id) || invoiced.has(r.id)} title={ticketed.has(r.id) || invoiced.has(r.id) ? 'Layanan sudah terkait ticket atau invoice' : 'Hapus'}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [ticketed, invoiced]);

  return (
    <>
      <PageHeader eyebrow="Service management" title="Layanan Aktif" description="Layanan yang sudah melewati aktivasi ticket. Layanan baru dibuat dari Ticketing."
        actions={<Button icon={ClipboardList} variant="secondary" onClick={() => navigate('/tickets')}>Ke Ticketing</Button>}/>
      <Alert tone="error" onDismiss={() => { remove.reset(); }}>{remove.error?.message}</Alert>
      <QueryGate queries={[subs, tickets, invoices]}>
        {() => {
          const rows = activatedServices(subs.data, tickets.data);
          const active = rows.filter(s => s.status === 'active');
          return <>
            <Figures cols={4}>
              <Figure label="Aktif" value={num(active.length)} sub="Masuk perhitungan MRR" to="/services?status=active"/>
              <Figure label="MRR aktif" value={idr(active.reduce((s, x) => s + x.monthly_fee, 0))}/>
              <Figure label="Suspended" value={num(rows.filter(s => s.status === 'suspended').length)} to="/services?status=suspended"/>
              <Figure label="Invoice otomatis" value={num(active.filter(s => s.invoice_mode === 'auto').length)} sub={`${num(active.filter(s => s.invoice_mode === 'manual').length)} manual`}/>
            </Figures>
            <DataTable id="services" data={rows} columns={columns} facets={facets} exportName="layanan" selectable
              searchText={r => [r.code, r.customer_name, r.plan_name, r.circuit_id, r.service_address, r.pppoe_username, r.router_name].join(' ')}
              searchPlaceholder="Cari service ID, pelanggan, paket, circuit ID, username PPPoE…"
              initialSort={[{id: 'customer', desc: false}]}
              bulkActions={(selected, clear) => <>
                <Button variant="secondary" className="small" disabled={bulk.isPending} onClick={() => setStatus(selected, 'active', clear)}>Set Aktif</Button>
                <Button variant="secondary" className="small" disabled={bulk.isPending} onClick={() => setStatus(selected, 'suspended', clear)}>Set Suspended</Button>
                <Button variant="secondary" className="small" disabled={bulk.isPending} onClick={() => setStatus(selected, 'terminated', clear)}>Set Terminasi</Button>
              </>}
              summary={list => <>MRR terfilter (aktif) <b>{idr(list.filter(s => s.status === 'active').reduce((s, x) => s + x.monthly_fee, 0))}</b></>}
              emptyTitle="Belum ada layanan aktif" emptyDesc="Layanan muncul setelah ticket diaktifkan oleh NOC."/>
          </>;
        }}
      </QueryGate>
      {editing && <ServiceForm service={editing} invoiced={invoiced.has(editing.id)} onClose={() => setEditing(null)}/>}
      {networking && <NetworkForm serviceId={networking} onClose={() => setNetworking(null)}/>}
    </>
  );
}
