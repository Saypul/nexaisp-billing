import React, {useMemo, useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api/client.js';
import {useApiMutation} from '../api/hooks.js';
import AuthImage from '../components/AuthImage.jsx';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {Alert, Button, Details, Dialog, Field, Figure, Figures, PageHeader, QueryGate} from '../components/ui.jsx';
import {fmtDateTime, idr, num, paymentMethodNames, proofStatusNames} from '../lib/format.js';

const tone = {pending: 'unpaid', approved: 'paid', rejected: 'overdue'};
const ProofStatus = ({status}) => <span className={'mark mark-' + tone[status]}><i aria-hidden="true"/>{proofStatusNames[status]}</span>;
const facets = [{id: 'status', title: 'Status', value: r => r.status, options: Object.entries(proofStatusNames)}];

export default function PaymentProofs() {
  const proofs = useQuery({queryKey: ['payment-proofs'], queryFn: () => api('/payment-proofs')});
  const [selected, setSelected] = useState(null);
  const columns = useMemo(() => [
    col('created_at', 'Dikirim', r => r.created_at, {cell: r => fmtDateTime(r.created_at)}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <Link to={'/customers/' + r.customer_id} onClick={e => e.stopPropagation()}>{r.customer_name}</Link>}),
    col('invoice', 'Invoice', r => r.invoice_number, {cell: r => <Link to={'/invoices/' + r.invoice_id} className="mono strong" onClick={e => e.stopPropagation()}>{r.invoice_number}</Link>}),
    col('sender', 'Nama pengirim', r => r.sender_name, {cell: r => r.sender_name || <span className="faint">—</span>}),
    col('amount', 'Nominal', r => r.amount, {align: 'num', cell: r => <span className="strong">{idr(r.amount)}</span>}),
    col('status', 'Status', r => r.status, {cell: r => <ProofStatus status={r.status}/>}),
    actionsCol(r => <button type="button" className="link-btn" onClick={() => setSelected(r)}>{r.status === 'pending' ? 'Verifikasi' : 'Lihat'}</button>),
  ], []);

  return (
    <>
      <PageHeader eyebrow="Finance · Aplikasi pelanggan" title="Bukti Transfer"
        description="Bukti transfer yang diunggah pelanggan. Cocokkan dengan mutasi rekening, lalu terima agar tercatat sebagai pembayaran."/>
      <QueryGate queries={[proofs]}>
        {() => {
          const pending = proofs.data.filter(p => p.status === 'pending');
          return <>
            <Figures cols={2}>
              <Figure label="Menunggu verifikasi" value={num(pending.length)} sub={idr(pending.reduce((s, p) => s + p.amount, 0))} tone={pending.length ? 'risk' : ''}/>
              <Figure tone="green" label="Diterima" value={num(proofs.data.filter(p => p.status === 'approved').length)} sub="Sudah menjadi pembayaran"/>
            </Figures>
            <DataTable id="payment-proofs" data={proofs.data} columns={columns} facets={facets} exportName="bukti-transfer"
              onRowClick={setSelected} rowLabel={r => 'Buka bukti transfer ' + r.invoice_number}
              searchPlaceholder="Cari pelanggan, invoice, pengirim…" emptyTitle="Belum ada bukti transfer"/>
          </>;
        }}
      </QueryGate>
      {selected && <ProofReview proof={selected} onClose={() => setSelected(null)}/>}
    </>
  );
}

function ProofReview({proof, onClose}) {
  const act = useApiMutation();
  const [rejecting, setRejecting] = useState(false);
  const approve = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    act.mutate({path: `/payment-proofs/${proof.id}/approve`, body: {amount: Number(raw.amount), method: raw.method}, success: 'Pembayaran dicatat'}, {onSuccess: onClose});
  };
  const reject = e => {
    e.preventDefault();
    act.mutate({path: `/payment-proofs/${proof.id}/reject`, body: {note: new FormData(e.currentTarget).get('note').trim()}, success: 'Bukti transfer ditolak'}, {onSuccess: onClose});
  };
  return (
    <Dialog title={'Bukti Transfer · ' + proof.invoice_number} onClose={onClose} size="lg">
      <div className="dialog-body">
        <Alert tone="error">{act.error?.message}</Alert>
        <div className="grid-2">
          <AuthImage url={proof.image_url} alt={'Bukti transfer ' + proof.invoice_number} label="Buka ukuran penuh"/>
          <Details entries={[
            ['Pelanggan', `${proof.customer_name} · ${proof.customer_code}`], ['Invoice', proof.invoice_number],
            ['Nominal diklaim', idr(proof.amount)], ['Nama pengirim', proof.sender_name], ['Catatan', proof.note],
            ['Dikirim', fmtDateTime(proof.created_at)], ['Status', <ProofStatus status={proof.status}/>],
            ...(proof.status !== 'pending' ? [['Diproses', `${proof.reviewed_by || '—'} · ${fmtDateTime(proof.reviewed_at)}`], ['Alasan', proof.review_note]] : []),
          ]}/>
        </div>
        {proof.status === 'pending' && !rejecting && (
          <form onSubmit={approve}>
            <div className="grid-2">
              <Field label="Nominal diterima" name="amount" type="number" min={1} required defaultValue={proof.amount} hint="Sesuaikan dengan mutasi rekening"/>
              <Field label="Metode" name="method" defaultValue="transfer">
                {Object.entries(paymentMethodNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Field>
            </div>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setRejecting(true)}>Tolak</Button>
              <Button type="submit" disabled={act.isPending}>{act.isPending ? 'Menyimpan…' : 'Terima & Catat Pembayaran'}</Button>
            </div>
          </form>
        )}
        {rejecting && (
          <form onSubmit={reject}>
            <Field label="Alasan penolakan (dilihat pelanggan)" name="note" as="textarea" required minLength={3} maxLength={500} placeholder="Contoh: Dana belum masuk ke rekening kami"/>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setRejecting(false)}>Batal</Button>
              <Button type="submit" className="danger" disabled={act.isPending}>Tolak Bukti Transfer</Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
