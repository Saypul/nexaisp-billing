import React, {useMemo, useState} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import {FileText} from 'lucide-react';
import {api} from '../api/client.js';
import {useBulkAction, useInvoices, useSubscriptions} from '../api/hooks.js';
import DataTable, {col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import {Button, Figure, Figures, InvoiceStatus, PageHeader, QueryGate} from '../components/ui.jsx';
import {DueDateDialog, GenerateInvoicesDialog} from '../forms/InvoiceForms.jsx';
import {daysPastDue, invoiceState, receivables} from '../lib/billing.js';
import {fmtDate, fmtPeriod, idr, invoiceModeNames, invoiceStateNames, num, todayPeriod} from '../lib/format.js';

const facets = [
  {id: 'state', title: 'Status', value: r => invoiceState(r), options: Object.entries(invoiceStateNames)},
  {id: 'period', title: 'Periode', value: r => r.period, label: fmtPeriod},
  {id: 'mode', title: 'Cara', value: r => r.invoice_mode, options: Object.entries(invoiceModeNames)},
];

const deletable = i => i.status !== 'paid' && !i.payments.length;

export default function Invoices() {
  const invoices = useInvoices();
  const subs = useSubscriptions();
  const navigate = useNavigate();
  const bulk = useBulkAction();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);
  const canGenerate = (subs.data || []).some(s => s.status === 'active' && s.invoice_mode === 'manual');

  const bulkDelete = async (rows, clear) => {
    const targets = rows.filter(deletable);
    const skipped = rows.length - targets.length;
    if (!targets.length) { await confirm({title: 'Tidak ada yang bisa dihapus', body: 'Invoice lunas atau yang sudah memiliki pembayaran tidak dapat dihapus.', confirmLabel: 'Mengerti'}); return; }
    if (!await confirm({title: `Hapus ${targets.length} invoice?`, body: `Invoice tanpa pembayaran akan dihapus permanen.${skipped ? ` ${skipped} invoice dengan pembayaran dilewati.` : ''}`, danger: true, confirmLabel: 'Hapus'})) return;
    bulk.mutate({items: targets, label: 'invoice dihapus', run: i => api('/invoices/' + i.id, {method: 'DELETE'})}, {onSuccess: clear});
  };

  const columns = useMemo(() => [
    col('number', 'Nomor', r => r.number, {cell: r => <Link to={'/invoices/' + r.id} className="mono strong" onClick={e => e.stopPropagation()}>{r.number}</Link>}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <Link to={'/customers/' + r.customer_id} onClick={e => e.stopPropagation()}>{r.customer_name}</Link>}),
    col('period', 'Periode', r => r.period, {cell: r => fmtPeriod(r.period)}),
    col('mode', 'Cara', r => invoiceModeNames[r.invoice_mode] || 'Manual'),
    col('due', 'Jatuh Tempo', r => r.due_date, {cell: r => fmtDate(r.due_date)}),
    col('age', 'Umur', r => daysPastDue(r), {align: 'num', cell: r => (daysPastDue(r) ? <span className="risk">{daysPastDue(r)} hari</span> : '—')}),
    col('total', 'Total', r => r.total, {align: 'num', cell: r => idr(r.total)}),
    col('paid', 'Dibayar', r => r.paid, {align: 'num', cell: r => idr(r.paid), hidden: true}),
    col('remaining', 'Sisa', r => r.remaining, {align: 'num', cell: r => <span className="strong">{idr(r.remaining)}</span>}),
    col('state', 'Status', r => invoiceStateNames[invoiceState(r)], {cell: r => <InvoiceStatus state={invoiceState(r)}/>}),
  ], []);

  return (
    <>
      <PageHeader eyebrow="Finance · Billing" title="Invoice" description="Satu invoice gabungan per pelanggan, periode, dan cara pembuatan. Invoice otomatis dibuat sistem setiap jam untuk periode berjalan."
        actions={<Button icon={FileText} onClick={() => setDialog({type: 'generate'})} disabled={!canGenerate} title={canGenerate ? undefined : 'Tidak ada layanan aktif berjenis Manual'}>Generate Invoice Manual</Button>}/>
      <QueryGate queries={[invoices]}>
        {() => {
          const list = invoices.data;
          const ar = receivables(list);
          const thisPeriod = list.filter(i => i.period === todayPeriod());
          return <>
            <Figures cols={4}>
              <Figure label="Piutang terbuka" value={idr(ar.total)} sub={`${num(list.filter(i => i.remaining > 0).length)} invoice`} to="/receivables"/>
              <Figure label="Lewat jatuh tempo" value={idr(ar.overdue)} sub={`${num(list.filter(i => invoiceState(i) === 'overdue').length)} invoice`} tone={ar.overdue ? 'risk' : ''} to="/invoices?state=overdue"/>
              <Figure label={'Ditagihkan ' + fmtPeriod(todayPeriod())} value={idr(thisPeriod.reduce((s, i) => s + i.total, 0))} sub={`${num(thisPeriod.length)} invoice`} to={'/invoices?period=' + todayPeriod()}/>
              <Figure label="Total invoice" value={num(list.length)} sub="Semua periode"/>
            </Figures>
            <DataTable id="invoices" data={list} columns={columns} facets={facets} exportName="invoice" selectable
              searchText={r => [r.number, r.customer_name, r.period, ...r.payments.map(p => p.reference)].join(' ')}
              searchPlaceholder="Cari nomor invoice, pelanggan, referensi pembayaran…"
              onRowClick={r => navigate('/invoices/' + r.id)} rowLabel={r => 'Buka invoice ' + r.number}
              bulkActions={(selected, clear) => <>
                <Button variant="secondary" className="small" disabled={bulk.isPending} onClick={() => setDialog({type: 'due', invoices: selected, clear})}>Ubah Jatuh Tempo</Button>
                <Button variant="danger" className="small" disabled={bulk.isPending} onClick={() => bulkDelete(selected, clear)}>Hapus</Button>
              </>}
              summary={rows => <>Total <b>{idr(rows.reduce((s, r) => s + r.total, 0))}</b> · Sisa <b>{idr(rows.reduce((s, r) => s + r.remaining, 0))}</b></>}
              emptyTitle="Belum ada invoice" emptyDesc="Invoice otomatis terbit untuk layanan Otomatis; layanan Manual memakai tombol Generate."/>
          </>;
        }}
      </QueryGate>
      {dialog?.type === 'generate' && <GenerateInvoicesDialog onClose={() => setDialog(null)}/>}
      {dialog?.type === 'due' && <DueDateDialog invoices={dialog.invoices} onDone={dialog.clear} onClose={() => setDialog(null)}/>}
    </>
  );
}
