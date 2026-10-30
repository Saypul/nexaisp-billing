import React, {useState} from 'react';
import {api} from '../api/client.js';
import {useApiMutation, useBulkAction} from '../api/hooks.js';
import {Alert, Button, Dialog, Field, FormActions} from '../components/ui.jsx';
import {idr, num, paymentMethodNames, todayDate, todayPeriod} from '../lib/format.js';

export function GenerateInvoicesDialog({onClose}) {
  const run = useApiMutation();
  const [result, setResult] = useState(null);
  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    run.mutate({path: '/invoices/generate', body: {period: raw.period, due_date: raw.due_date}, success: 'Generate invoice manual selesai'}, {onSuccess: setResult});
  };
  return (
    <Dialog title="Generate Invoice Manual" onClose={onClose}>
      {result ? (
        <div className="dialog-body">
          <div className="result-grid">
            <div><b>{num(result.created)}</b><span>invoice baru</span></div>
            <div><b>{num(result.updated)}</b><span>invoice ditambah item</span></div>
            <div><b>{num(result.skipped)}</b><span>pelanggan dilewati (sudah ditagih)</span></div>
          </div>
          {result.numbers?.length > 0 && <p className="fineprint mono">{result.numbers.slice(0, 30).join(', ')}{result.numbers.length > 30 ? ` dan ${result.numbers.length - 30} lainnya` : ''}</p>}
          <div className="dialog-actions"><Button onClick={onClose}>Selesai</Button></div>
        </div>
      ) : (
        <form className="dialog-body" onSubmit={submit}>
          <Alert tone="error">{run.error?.message}</Alert>
          <Alert>Hanya untuk layanan aktif berjenis <b>Manual</b>. Layanan Otomatis ditagih sistem setiap jam untuk periode berjalan. Prepaid menagih bulan invoice, postpaid bulan sebelumnya, OTC ditagih sekali.</Alert>
          <div className="grid-2">
            <Field label="Periode Tagihan" name="period" type="month" required defaultValue={todayPeriod()}/>
            <Field label="Jatuh Tempo" name="due_date" type="date" required defaultValue={todayDate()}/>
          </div>
          <p className="fineprint">Pajak, diskon, dan prorata belum dihitung oleh backend.</p>
          <FormActions onCancel={onClose} pending={run.isPending} submitLabel="Generate"/>
        </form>
      )}
    </Dialog>
  );
}

// Ubah jatuh tempo untuk satu invoice atau banyak invoice sekaligus (invoice lunas dilewati).
export function DueDateDialog({invoices, onClose, onDone}) {
  const editable = invoices.filter(i => i.status !== 'paid');
  const single = useApiMutation();
  const bulk = useBulkAction();
  const pending = single.isPending || bulk.isPending;
  const submit = e => {
    e.preventDefault();
    const due_date = new FormData(e.currentTarget).get('due_date');
    if (editable.length === 1) single.mutate({path: '/invoices/' + editable[0].id, method: 'PUT', body: {due_date}, success: 'Jatuh tempo diperbarui'}, {onSuccess: () => { onDone?.(); onClose(); }});
    else bulk.mutate({items: editable, label: 'invoice diperbarui', run: inv => api('/invoices/' + inv.id, {method: 'PUT', body: {due_date}})}, {onSuccess: () => { onDone?.(); onClose(); }});
  };
  return (
    <Dialog title={editable.length === 1 ? 'Ubah Jatuh Tempo ' + editable[0].number : `Ubah Jatuh Tempo · ${num(editable.length)} invoice`} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{single.error?.message}</Alert>
        {editable.length < invoices.length && <Alert>{invoices.length - editable.length} invoice lunas dilewati karena tidak dapat diubah.</Alert>}
        <Field label="Jatuh Tempo Baru" name="due_date" type="date" required defaultValue={editable.length === 1 ? editable[0].due_date : todayDate()}/>
        <FormActions onCancel={onClose} pending={pending} disabled={!editable.length} submitLabel="Simpan"/>
      </form>
    </Dialog>
  );
}

export function PaymentForm({invoice}) {
  const pay = useApiMutation();
  const submit = e => {
    e.preventDefault();
    const form = e.currentTarget;
    const raw = Object.fromEntries(new FormData(form));
    pay.mutate(
      {path: `/invoices/${invoice.id}/payments`, body: {amount: Number(raw.amount), method: raw.method, reference: raw.reference || null}, success: 'Pembayaran tercatat'},
      {onSuccess: () => form.reset()},
    );
  };
  return (
    <form className="pay-form" onSubmit={submit} key={invoice.remaining}>
      <h3>Catat Pembayaran</h3>
      <Alert tone="error">{pay.error?.message}</Alert>
      <Field label="Jumlah (Rp)" name="amount" type="number" min="1" max={invoice.remaining} required defaultValue={invoice.remaining} hint={'Sisa tagihan ' + idr(invoice.remaining)}/>
      <Field label="Metode" name="method" required defaultValue="transfer">
        {Object.entries(paymentMethodNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Field>
      <Field label="Referensi Transaksi" name="reference" maxLength={120} placeholder="Nomor bukti transfer" hint="Referensi yang sama tidak bisa dipakai dua kali pada invoice ini"/>
      <Button type="submit" disabled={pay.isPending}>{pay.isPending ? 'Menyimpan…' : 'Simpan Pembayaran'}</Button>
      <p className="fineprint">Pencatatan manual; tidak melakukan settlement ke payment gateway.</p>
    </form>
  );
}
