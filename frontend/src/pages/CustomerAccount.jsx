import React, {useMemo, useState} from 'react';
import {Link, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {ArrowLeft, ClipboardList, Pencil, Printer, Trash2} from 'lucide-react';
import {useApiMutation, useCustomers, useInvoices, useSubscriptions, useTickets} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import TicketDetail from '../components/TicketDetail.jsx';
import {Alert, Button, Details, Empty, Figure, Figures, InvoiceStatus, NetworkStatus, PageHeader, QueryGate, ServiceStatus, Tabs, TicketBadge} from '../components/ui.jsx';
import CustomerForm from '../forms/CustomerForm.jsx';
import NetworkForm from '../forms/NetworkForm.jsx';
import ServiceForm from '../forms/ServiceForm.jsx';
import TicketForm from '../forms/TicketForm.jsx';
import {daysPastDue, invoiceState, invoicedServiceIds, statement} from '../lib/billing.js';
import {billingNames, categories, fmtDate, fmtDateTime, idr, invoiceModeNames, kinds, paymentMethodNames} from '../lib/format.js';

export default function CustomerAccount() {
  const {id} = useParams();
  const customers = useCustomers();
  const subs = useSubscriptions();
  const invoices = useInvoices();
  const tickets = useTickets();
  return (
    <QueryGate queries={[customers, subs, invoices, tickets]}>
      {() => {
        const customer = customers.data.find(c => c.id === Number(id));
        if (!customer) return <><PageHeader title="Pelanggan tidak ditemukan"/><Link className="link-btn" to="/customers"><ArrowLeft size={14}/> Kembali ke daftar pelanggan</Link></>;
        return <Account customer={customer}
          services={subs.data.filter(s => s.customer_id === customer.id)}
          invoices={invoices.data.filter(i => i.customer_id === customer.id)}
          tickets={tickets.data.filter(t => t.customer_id === customer.id)}/>;
      }}
    </QueryGate>
  );
}

function Account({customer, services, invoices, tickets}) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'invoices';
  const navigate = useNavigate();
  const confirm = useConfirm();
  const remove = useApiMutation();
  const [dialog, setDialog] = useState(null);
  const ledger = useMemo(() => statement(invoices), [invoices]);
  const invoiced = useMemo(() => invoicedServiceIds(invoices), [invoices]);

  const outstanding = invoices.reduce((s, i) => s + Math.max(0, i.remaining), 0);
  const overdue = invoices.filter(i => invoiceState(i) === 'overdue').reduce((s, i) => s + i.remaining, 0);
  const paid = invoices.reduce((s, i) => s + i.paid, 0);
  const mrr = services.filter(s => s.status === 'active').reduce((s, x) => s + x.monthly_fee, 0);
  const deletable = !services.length && !invoices.length && !tickets.length;

  const destroy = async () => {
    if (!await confirm({title: 'Hapus pelanggan?', body: `${customer.name} (${customer.code}) akan dihapus permanen.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/customers/' + customer.id, method: 'DELETE', success: 'Pelanggan dihapus'}, {onSuccess: () => navigate('/customers')});
  };

  const setTab = t => setParams(p => { const n = new URLSearchParams(p); n.set('tab', t); return n; }, {replace: true});

  return (
    <>
      <Link className="crumb" to="/customers"><ArrowLeft size={14}/> Pelanggan</Link>
      <PageHeader eyebrow={`${kinds[customer.kind]} · ID ${customer.code}`} title={customer.name}
        actions={<>
          <Button variant="secondary" icon={Pencil} onClick={() => setDialog({type: 'edit'})}>Edit</Button>
          <Button variant="secondary" icon={ClipboardList} onClick={() => setDialog({type: 'ticket'})}>Ticket Layanan Baru</Button>
          <Button variant="ghost" icon={Trash2} onClick={destroy} disabled={!deletable || remove.isPending} title={deletable ? 'Hapus pelanggan' : 'Pelanggan memiliki layanan, ticket, atau invoice'}>Hapus</Button>
        </>}/>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      <Details columns={4} entries={[['Email', customer.email], ['Telepon', customer.phone], ['Alamat', customer.address], ['Layanan', `${services.filter(s => s.status === 'active').length} aktif dari ${services.length}`]]}/>
      <Figures cols={4}>
        <Figure label="MRR" value={idr(mrr)} sub="Layanan aktif"/>
        <Figure label="Piutang" value={idr(outstanding)} sub={`${invoices.filter(i => i.remaining > 0).length} invoice terbuka`}/>
        <Figure label="Lewat jatuh tempo" value={idr(overdue)} tone={overdue ? 'risk' : ''}/>
        <Figure label="Total dibayar" value={idr(paid)} sub="Sepanjang waktu"/>
      </Figures>

      <Tabs current={tab} onChange={setTab} tabs={[['invoices', 'Invoice', invoices.length], ['statement', 'Mutasi', ledger.length], ['services', 'Layanan', services.length], ['tickets', 'Ticket', tickets.length]]}/>

      {tab === 'invoices' && <InvoicesTab invoices={invoices} navigate={navigate}/>}
      {tab === 'statement' && <StatementTab customer={customer} ledger={ledger} navigate={navigate}/>}
      {tab === 'services' && <ServicesTab services={services} invoiced={invoiced} setDialog={setDialog}/>}
      {tab === 'tickets' && <TicketsTab tickets={tickets} setDialog={setDialog}/>}

      {dialog?.type === 'edit' && <CustomerForm customer={customer} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'ticket' && <TicketForm customerId={customer.id} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'network' && <NetworkForm serviceId={dialog.id} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'service' && <ServiceForm service={dialog.service} invoiced={invoiced.has(dialog.service.id)} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'view_ticket' && <TicketDetail ticket={tickets.find(t => t.id === dialog.id) || dialog.ticket} onClose={() => setDialog(null)}/>}
    </>
  );
}

function InvoicesTab({invoices, navigate}) {
  const columns = useMemo(() => [
    col('number', 'Nomor', r => r.number, {cell: r => <span className="mono strong">{r.number}</span>}),
    col('period', 'Periode', r => r.period),
    col('mode', 'Cara', r => invoiceModeNames[r.invoice_mode]),
    col('due', 'Jatuh Tempo', r => r.due_date, {cell: r => fmtDate(r.due_date)}),
    col('age', 'Umur', r => daysPastDue(r), {align: 'num', cell: r => (daysPastDue(r) ? <span className="risk">{daysPastDue(r)} hari</span> : '—')}),
    col('total', 'Total', r => r.total, {align: 'num', cell: r => idr(r.total)}),
    col('remaining', 'Sisa', r => r.remaining, {align: 'num', cell: r => idr(r.remaining)}),
    col('state', 'Status', r => invoiceState(r), {cell: r => <InvoiceStatus state={invoiceState(r)}/>}),
  ], []);
  return <DataTable id="account-invoices" syncUrl={false} data={invoices} columns={columns} exportName="invoice-pelanggan"
    onRowClick={r => navigate('/invoices/' + r.id)} rowLabel={r => 'Buka invoice ' + r.number}
    initialSort={[{id: 'period', desc: true}]} emptyTitle="Belum ada invoice"/>;
}

function StatementTab({customer, ledger, navigate}) {
  if (!ledger.length) return <Empty title="Belum ada mutasi" desc="Mutasi muncul setelah invoice diterbitkan."/>;
  const balance = ledger[ledger.length - 1].balance;
  return (
    <section className="statement print-doc">
      <div className="statement-head">
        <div><div className="eyebrow">Mutasi rekening pelanggan</div><h2>{customer.name}</h2><p className="mono">{customer.code}</p></div>
        <div className="statement-balance"><span>Saldo tagihan</span><strong>{idr(balance)}</strong><small>per {fmtDate(new Date().toISOString())}</small></div>
        <Button variant="secondary" icon={Printer} className="no-print" onClick={() => window.print()}>Cetak</Button>
      </div>
      <div className="dt-scroll">
        <table className="ledger">
          <thead><tr><th>Tanggal</th><th>Keterangan</th><th>Referensi</th><th className="a-num">Debit</th><th className="a-num">Kredit</th><th className="a-num">Saldo</th></tr></thead>
          <tbody>
            {ledger.map(e => (
              <tr key={e.key} className="clickable" onClick={() => navigate('/invoices/' + e.invoice_id)}>
                <td>{fmtDate(e.date)}</td>
                <td>{e.description}{e.method && <span className="sub"> · {paymentMethodNames[e.method]}</span>}</td>
                <td className="mono">{e.ref}</td>
                <td className="a-num">{e.debit ? idr(e.debit) : ''}</td>
                <td className="a-num">{e.credit ? idr(e.credit) : ''}</td>
                <td className="a-num strong">{idr(e.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fineprint">Invoice dicatat pada tanggal jatuh tempo; pembayaran pada tanggal diterima.</p>
    </section>
  );
}

function ServicesTab({services, invoiced, setDialog}) {
  const columns = useMemo(() => [
    col('code', 'Service ID', r => r.code, {cell: r => <span className="mono strong">{r.code}</span>}),
    col('plan', 'Paket', r => r.plan_name, {cell: r => <>{r.plan_name}<div className="sub">{categories[r.category]}{r.bandwidth_mbps ? ` · ${r.bandwidth_mbps} Mbps` : ''}</div></>}),
    col('billing', 'Billing', r => `${billingNames[r.billing_type]} · ${invoiceModeNames[r.invoice_mode]}`),
    col('mrc', 'MRC', r => r.monthly_fee, {align: 'num', cell: r => idr(r.monthly_fee)}),
    col('start', 'Mulai', r => r.start_date, {cell: r => fmtDate(r.start_date)}),
    col('circuit', 'Circuit ID', r => r.circuit_id),
    col('status', 'Status', r => r.status, {cell: r => <ServiceStatus status={r.status}/>}),
    col('network', 'Jaringan', r => r.network_state, {cell: r => <NetworkStatus state={r.network_state} reason={r.isolation_reason}/>}),
    actionsCol(r => <><button type="button" className="link-btn" onClick={() => setDialog({type: 'network', id: r.id})}>Jaringan</button><button type="button" className="link-btn" onClick={() => setDialog({type: 'service', service: r})} disabled={r.status === 'pending'} title={r.status === 'pending' ? 'Layanan pending dikelola dari Ticketing' : undefined}>Edit</button></>),
  ], [setDialog]);
  return <DataTable id="account-services" syncUrl={false} data={services} columns={columns} exportName="layanan-pelanggan" emptyTitle="Belum ada layanan"/>;
}

function TicketsTab({tickets, setDialog}) {
  const columns = useMemo(() => [
    col('wo', 'WO', r => r.work_order_code, {cell: r => <span className="mono strong">{r.work_order_code}</span>}),
    col('code', 'Ticket', r => r.code, {cell: r => <span className="mono">{r.code}</span>}),
    col('plan', 'Paket', r => r.plan_name),
    col('status', 'Progres', r => r.status, {cell: r => <TicketBadge status={r.status} team={r.work_order_team}/>}),
    col('created', 'Dibuat', r => r.created_at, {cell: r => fmtDateTime(r.created_at)}),
  ], []);
  return <DataTable id="account-tickets" syncUrl={false} data={tickets} columns={columns} onRowClick={r => setDialog({type: 'view_ticket', id: r.id, ticket: r})} emptyTitle="Belum ada ticket"/>;
}
