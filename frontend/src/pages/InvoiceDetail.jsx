import React, {useState} from 'react';
import {Link, useNavigate, useParams} from 'react-router-dom';
import {ArrowLeft, CalendarClock, Printer, Trash2} from 'lucide-react';
import {useApiMutation, useCustomers, useInvoices} from '../api/hooks.js';
import {useConfirm} from '../components/feedback.jsx';
import {Alert, Button, InvoiceStatus, PageHeader, QueryGate} from '../components/ui.jsx';
import {DueDateDialog, PaymentForm} from '../forms/InvoiceForms.jsx';
import {daysPastDue, invoiceState} from '../lib/billing.js';
import {chargeTypeNames, fmtDate, fmtDateTime, fmtPeriod, idr, invoiceModeNames, kinds, paymentMethodNames} from '../lib/format.js';

export default function InvoiceDetail() {
  const {id} = useParams();
  const invoices = useInvoices();
  const customers = useCustomers();
  return (
    <QueryGate queries={[invoices, customers]}>
      {() => {
        const invoice = invoices.data.find(i => i.id === Number(id));
        if (!invoice) return <><PageHeader title="Invoice tidak ditemukan"/><Link className="link-btn" to="/invoices"><ArrowLeft size={14}/> Kembali ke daftar invoice</Link></>;
        return <Invoice invoice={invoice} customer={customers.data.find(c => c.id === invoice.customer_id)}/>;
      }}
    </QueryGate>
  );
}

function Invoice({invoice, customer}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const remove = useApiMutation();
  const [editingDue, setEditingDue] = useState(false);
  const state = invoiceState(invoice);
  const late = daysPastDue(invoice);
  const canDelete = invoice.status !== 'paid' && !invoice.payments.length;

  const destroy = async () => {
    if (!await confirm({title: 'Hapus invoice?', body: `${invoice.number} akan dihapus permanen. Item tagihannya dapat diterbitkan ulang.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/invoices/' + invoice.id, method: 'DELETE', success: 'Invoice dihapus'}, {onSuccess: () => navigate('/invoices')});
  };

  return (
    <>
      <Link className="crumb no-print" to="/invoices"><ArrowLeft size={14}/> Invoice</Link>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      <div className="invoice-layout">
        <article className="invoice-doc print-doc">
          <header className="doc-head">
            <div>
              <div className="doc-brand">NexaISP</div>
              <div className="eyebrow">Invoice</div>
              <h1 className="mono">{invoice.number}</h1>
            </div>
            <div className="doc-status"><InvoiceStatus state={state}/>{late > 0 && <span className="risk">{late} hari lewat jatuh tempo</span>}</div>
          </header>
          <div className="doc-parties">
            <div>
              <div className="eyebrow">Ditagihkan kepada</div>
              <b><Link to={'/customers/' + invoice.customer_id}>{invoice.customer_name}</Link></b>
              {customer && <>
                <span className="mono">ID {customer.code} · {kinds[customer.kind]}</span>
                {customer.address && <span>{customer.address}</span>}
                {customer.email && <span>{customer.email}</span>}
                {customer.phone && <span>{customer.phone}</span>}
              </>}
            </div>
            <dl className="doc-meta">
              <div><dt>Periode</dt><dd>{fmtPeriod(invoice.period)}</dd></div>
              <div><dt>Jatuh tempo</dt><dd>{fmtDate(invoice.due_date)}</dd></div>
              <div><dt>Cara pembuatan</dt><dd>{invoiceModeNames[invoice.invoice_mode] || 'Manual'}</dd></div>
            </dl>
          </div>
          <table className="doc-lines">
            <thead><tr><th>#</th><th>Uraian</th><th>Jenis</th><th className="a-num">Jumlah</th></tr></thead>
            <tbody>
              {invoice.items.map((item, index) => (
                <tr key={index}><td className="faint">{String(index + 1).padStart(2, '0')}</td><td>{item.description}</td><td>{chargeTypeNames[item.charge_type] || item.charge_type}</td><td className="a-num">{idr(item.amount)}</td></tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="grand"><td/><th colSpan={2}>Total</th><td className="a-num">{idr(invoice.total)}</td></tr>
              <tr><td/><td colSpan={2}>Sudah dibayar</td><td className="a-num">{idr(invoice.paid)}</td></tr>
              <tr className="due"><td/><th colSpan={2}>Sisa tagihan</th><td className="a-num">{idr(invoice.remaining)}</td></tr>
            </tfoot>
          </table>
          {invoice.payments.length > 0 && (
            <section className="doc-payments">
              <h3>Riwayat pembayaran</h3>
              <table>
                <thead><tr><th>Tanggal</th><th>Metode</th><th>Referensi</th><th className="a-num">Jumlah</th></tr></thead>
                <tbody>{invoice.payments.map(p => <tr key={p.id}><td>{fmtDateTime(p.paid_at)}</td><td>{paymentMethodNames[p.method] || p.method}</td><td className="mono">{p.reference || '—'}</td><td className="a-num">{idr(p.amount)}</td></tr>)}</tbody>
              </table>
            </section>
          )}
          <p className="fineprint">Belum termasuk pajak, diskon, atau prorata.</p>
        </article>

        <aside className="invoice-side no-print">
          <div className="side-actions">
            <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Cetak / Simpan PDF</Button>
            <Button variant="secondary" icon={CalendarClock} onClick={() => setEditingDue(true)} disabled={invoice.status === 'paid'}>Ubah Jatuh Tempo</Button>
            <Button variant="ghost" icon={Trash2} onClick={destroy} disabled={!canDelete || remove.isPending} title={canDelete ? 'Hapus invoice' : 'Invoice lunas atau dengan pembayaran tidak dapat dihapus'}>Hapus</Button>
          </div>
          {invoice.remaining > 0 ? <PaymentForm invoice={invoice}/> : <Alert>Invoice ini sudah lunas.</Alert>}
        </aside>
      </div>
      {editingDue && <DueDateDialog invoices={[invoice]} onClose={() => setEditingDue(false)}/>}
    </>
  );
}
