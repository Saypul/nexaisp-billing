import React, {useMemo} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import {useInvoices} from '../api/hooks.js';
import DataTable, {col} from '../components/DataTable.jsx';
import {Figure, Figures, PageHeader, QueryGate} from '../components/ui.jsx';
import {flattenPayments} from '../lib/billing.js';
import {fmtDateTime, fmtPeriod, idr, num, paymentMethodNames, todayPeriod} from '../lib/format.js';

const facets = [
  {id: 'month', title: 'Bulan diterima', value: r => String(r.paid_at).slice(0, 7), label: fmtPeriod},
  {id: 'method', title: 'Metode', value: r => r.method, options: Object.entries(paymentMethodNames)},
];

export default function Payments() {
  const invoices = useInvoices();
  const navigate = useNavigate();
  const columns = useMemo(() => [
    col('paid_at', 'Diterima', r => r.paid_at, {cell: r => fmtDateTime(r.paid_at)}),
    col('invoice', 'Invoice', r => r.invoice_number, {cell: r => <Link to={'/invoices/' + r.invoice_id} className="mono strong" onClick={e => e.stopPropagation()}>{r.invoice_number}</Link>}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <Link to={'/customers/' + r.customer_id} onClick={e => e.stopPropagation()}>{r.customer_name}</Link>}),
    col('period', 'Periode Invoice', r => r.period, {cell: r => fmtPeriod(r.period)}),
    col('method', 'Metode', r => paymentMethodNames[r.method] || r.method),
    col('reference', 'Referensi', r => r.reference, {cell: r => r.reference ? <span className="mono">{r.reference}</span> : <span className="faint">—</span>}),
    col('amount', 'Jumlah', r => r.amount, {align: 'num', cell: r => <span className="strong">{idr(r.amount)}</span>}),
  ], []);

  return (
    <>
      <PageHeader eyebrow="Finance · Cash in" title="Pembayaran" description="Buku penerimaan dari seluruh invoice. Pembayaran dicatat manual dari halaman invoice."/>
      <QueryGate queries={[invoices]}>
        {() => {
          const rows = flattenPayments(invoices.data);
          const month = rows.filter(p => String(p.paid_at).startsWith(todayPeriod()));
          const missingRef = rows.filter(p => !p.reference && p.method !== 'cash');
          return <>
            <Figures cols={3}>
              <Figure label={'Diterima ' + fmtPeriod(todayPeriod())} value={idr(month.reduce((s, p) => s + p.amount, 0))} sub={`${num(month.length)} transaksi`} to={'/payments?month=' + todayPeriod()}/>
              <Figure label="Seluruh penerimaan" value={idr(rows.reduce((s, p) => s + p.amount, 0))} sub={`${num(rows.length)} transaksi`}/>
              <Figure label="Non-tunai tanpa referensi" value={num(missingRef.length)} sub="Perlu dilengkapi untuk rekonsiliasi" tone={missingRef.length ? 'risk' : ''}/>
            </Figures>
            <DataTable id="payments" data={rows} columns={columns} facets={facets} exportName="pembayaran"
              searchText={r => [r.invoice_number, r.customer_name, r.reference, r.method].join(' ')}
              searchPlaceholder="Cari invoice, pelanggan, referensi…"
              onRowClick={r => navigate('/invoices/' + r.invoice_id)} rowLabel={r => 'Buka invoice ' + r.invoice_number}
              initialSort={[{id: 'paid_at', desc: true}]}
              summary={list => <>Jumlah terfilter <b>{idr(list.reduce((s, p) => s + p.amount, 0))}</b></>}
              emptyTitle="Belum ada pembayaran" emptyDesc="Catat pembayaran dari halaman detail invoice."/>
          </>;
        }}
      </QueryGate>
    </>
  );
}
