import React, {useMemo} from 'react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {useInvoices} from '../api/hooks.js';
import AgingStrip from '../components/AgingStrip.jsx';
import DataTable, {col} from '../components/DataTable.jsx';
import {Figure, Figures, PageHeader, QueryGate} from '../components/ui.jsx';
import {agingBuckets, receivables} from '../lib/billing.js';
import {fmtDate, idr, num} from '../lib/format.js';

const facets = [
  {id: 'bucket', title: 'Bersaldo di', match: (r, key) => r[key] > 0, options: agingBuckets.map(b => [b.key, b.label])},
];

export default function Receivables() {
  const invoices = useInvoices();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const columns = useMemo(() => [
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <span className="strong">{r.customer_name}</span>}),
    col('open', 'Invoice', r => r.open, {align: 'num'}),
    col('oldest', 'Jatuh Tempo Tertua', r => r.oldest_due, {cell: r => fmtDate(r.oldest_due)}),
    ...agingBuckets.map((b, i) => col(b.key, b.short, r => r[b.key], {align: 'num', cell: r => (r[b.key] ? <span className={i ? 'risk' : ''}>{idr(r[b.key])}</span> : <span className="faint">—</span>)})),
    col('total', 'Total', r => r.total, {align: 'num', cell: r => <span className="strong">{idr(r.total)}</span>}),
  ], []);

  return (
    <>
      <PageHeader eyebrow="Finance · Collections" title="Piutang & Aging" description="Saldo tagihan terbuka per pelanggan menurut umur sejak jatuh tempo. Pakai sebagai daftar kerja penagihan."/>
      <QueryGate queries={[invoices]}>
        {() => {
          const ar = receivables(invoices.data);
          const rows = ar.customers;
          return <>
            <Figures cols={3}>
              <Figure label="Total piutang" value={idr(ar.total)} sub={`${num(rows.length)} pelanggan`}/>
              <Figure label="Lewat jatuh tempo" value={idr(ar.overdue)} tone={ar.overdue ? 'risk' : ''} sub={`${num(rows.filter(r => r.total > r.current).length)} pelanggan`}/>
              <Figure label="Lebih dari 90 hari" value={idr(ar.buckets.d90p.amount)} tone={ar.buckets.d90p.amount ? 'risk' : ''} sub="Prioritas penagihan"/>
            </Figures>
            <AgingStrip summary={ar} active={params.get('bucket')}/>
            <DataTable id="receivables" data={rows} columns={columns} facets={facets} exportName="piutang-aging"
              searchText={r => r.customer_name}
              searchPlaceholder="Cari pelanggan…"
              onRowClick={r => navigate('/customers/' + r.id + '?tab=statement')} rowLabel={r => 'Mutasi ' + r.customer_name}
              initialSort={[{id: 'total', desc: true}]}
              summary={list => <>Total terfilter <b>{idr(list.reduce((s, r) => s + r.total, 0))}</b></>}
              emptyTitle="Tidak ada piutang" emptyDesc="Semua invoice sudah lunas."/>
          </>;
        }}
      </QueryGate>
    </>
  );
}
