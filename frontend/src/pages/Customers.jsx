import React, {useMemo, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Plus} from 'lucide-react';
import {useCustomers, useInvoices, useSubscriptions, useTickets} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {Button, Figure, Figures, PageHeader, QueryGate, TicketBadge} from '../components/ui.jsx';
import CustomerForm from '../forms/CustomerForm.jsx';
import {customerRollups} from '../lib/billing.js';
import {idr, kinds, num} from '../lib/format.js';

const facets = [
  {id: 'kind', title: 'Jenis', value: r => r.kind, options: Object.entries(kinds)},
  {id: 'balance', title: 'Saldo', value: r => (r.overdue > 0 ? 'overdue' : r.outstanding > 0 ? 'open' : 'clear'), options: [['overdue', 'Lewat jatuh tempo'], ['open', 'Ada tagihan'], ['clear', 'Tidak ada tagihan']]},
];

export default function Customers() {
  const customers = useCustomers();
  const subs = useSubscriptions();
  const invoices = useInvoices();
  const tickets = useTickets();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(null);

  return (
    <>
      <PageHeader eyebrow="CRM · Master data" title="Pelanggan" description="Akun residential, business, dan corporate beserta posisi tagihannya."
        actions={<Button icon={Plus} onClick={() => setDialog({type: 'create'})}>Pelanggan Baru</Button>}/>
      <QueryGate queries={[customers, subs, invoices, tickets]}>
        {() => <Table customers={customers.data} subs={subs.data} invoices={invoices.data} tickets={tickets.data} navigate={navigate} setDialog={setDialog}/>}
      </QueryGate>
      {dialog?.type === 'create' && <CustomerForm onClose={() => setDialog(null)} onSaved={c => navigate('/customers/' + c.id)}/>}
      {dialog?.type === 'edit' && <CustomerForm customer={dialog.customer} onClose={() => setDialog(null)}/>}
    </>
  );
}

function Table({customers, subs, invoices, tickets, navigate, setDialog}) {
  const rows = useMemo(() => {
    const rollups = customerRollups(subs, invoices, tickets);
    return customers.map(c => ({...c, ...(rollups.get(c.id) || {active: 0, mrr: 0, outstanding: 0, overdue: 0, openTickets: 0, latestTicket: null})}));
  }, [customers, subs, invoices, tickets]);

  const columns = useMemo(() => [
    col('code', 'ID Pelanggan', r => r.code, {cell: r => <span className="mono">{r.code}</span>}),
    col('name', 'Nama', r => r.name, {cell: r => <span className="strong">{r.name}</span>}),
    col('kind', 'Jenis', r => kinds[r.kind]),
    col('email', 'Email', r => r.email, {hidden: true}),
    col('phone', 'Telepon', r => r.phone),
    col('active', 'Layanan Aktif', r => r.active, {align: 'num'}),
    col('mrr', 'MRR', r => r.mrr, {align: 'num', cell: r => idr(r.mrr)}),
    col('outstanding', 'Piutang', r => r.outstanding, {align: 'num', cell: r => idr(r.outstanding)}),
    col('overdue', 'Lewat JT', r => r.overdue, {align: 'num', cell: r => <span className={r.overdue ? 'risk' : 'faint'}>{idr(r.overdue)}</span>}),
    col('ticket', 'Ticket', r => r.latestTicket?.status, {cell: r => (r.latestTicket ? <TicketBadge status={r.latestTicket.status} team={r.latestTicket.work_order_team}/> : '—'), csv: r => r.latestTicket?.status || ''}),
    actionsCol(r => <button type="button" className="link-btn" onClick={() => setDialog({type: 'edit', customer: r})}>Edit</button>),
  ], [setDialog]);

  const totals = rows.reduce((t, r) => ({mrr: t.mrr + r.mrr, outstanding: t.outstanding + r.outstanding, corporate: t.corporate + (r.kind === 'corporate' ? 1 : 0)}), {mrr: 0, outstanding: 0, corporate: 0});

  return (
    <>
      <Figures cols={4}>
        <Figure label="Total pelanggan" value={num(rows.length)}/>
        <Figure label="Corporate" value={num(totals.corporate)} sub="Akun perusahaan"/>
        <Figure label="MRR seluruh akun" value={idr(totals.mrr)}/>
        <Figure label="Piutang seluruh akun" value={idr(totals.outstanding)} to="/receivables"/>
      </Figures>
      <DataTable id="customers" data={rows} columns={columns} facets={facets} exportName="pelanggan"
        searchText={r => [r.code, r.name, r.email, r.phone, r.address].join(' ')}
        searchPlaceholder="Cari nama, ID, email, telepon, alamat…"
        onRowClick={r => navigate('/customers/' + r.id)} rowLabel={r => 'Buka akun ' + r.name}
        initialSort={[{id: 'name', desc: false}]}
        emptyTitle="Belum ada pelanggan" emptyDesc="Tambah pelanggan pertama; ticket onboarding dibuat otomatis."
        summary={list => <>MRR terfilter <b>{idr(list.reduce((s, r) => s + r.mrr, 0))}</b> · Piutang <b>{idr(list.reduce((s, r) => s + r.outstanding, 0))}</b></>}/>
    </>
  );
}
