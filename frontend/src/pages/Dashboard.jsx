import React, {useMemo, useState} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import {ArrowUpRight, CalendarClock, Plus, Receipt, UsersRound, Wallet, Wifi} from 'lucide-react';
import {useDashboard, useInvoices, useTickets} from '../api/hooks.js';
import AgingStrip from '../components/AgingStrip.jsx';
import {Button, Empty, Figure, Figures, InvoiceStatus, PageHeader, QueryGate, Section, TicketBadge} from '../components/ui.jsx';
import CustomerForm from '../forms/CustomerForm.jsx';
import {invoiceState, receivables} from '../lib/billing.js';
import {categories, compactIdr, fmtDate, fmtPeriod, idr, num, percent, ticketStatusNames, todayPeriod} from '../lib/format.js';

export default function Dashboard() {
  const dashboard = useDashboard();
  const invoices = useInvoices();
  const tickets = useTickets();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader eyebrow={new Date().toLocaleDateString('id-ID', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'})}
        title="Dashboard" description="Posisi pendapatan, piutang, dan operasional dari database billing."
        actions={<Button icon={Plus} onClick={() => setCreating(true)}>Pelanggan Baru</Button>}/>
      <QueryGate queries={[dashboard, invoices, tickets]}>
        {() => <Body d={dashboard.data} invoices={invoices.data} tickets={tickets.data} navigate={navigate}/>}
      </QueryGate>
      {creating && <CustomerForm onClose={() => setCreating(false)} onSaved={c => navigate('/customers/' + c.id)}/>}
    </>
  );
}

function Body({d, invoices, tickets, navigate}) {
  const ar = useMemo(() => receivables(invoices), [invoices]);
  const period = todayPeriod();
  const current = useMemo(() => {
    const list = invoices.filter(i => i.period === period);
    const billed = list.reduce((s, i) => s + i.total, 0);
    const collected = list.reduce((s, i) => s + i.paid, 0);
    return {count: list.length, billed, collected, open: list.filter(i => i.remaining > 0).length};
  }, [invoices, period]);
  const pipeline = useMemo(() => {
    const counts = {};
    for (const t of tickets) if (t.status !== 'closed') counts[t.status] = (counts[t.status] || 0) + 1;
    return counts;
  }, [tickets]);
  const maxCategory = Math.max(1, ...(d.revenue_by_category || []).map(x => x.amount));
  const rate = percent(current.collected, current.billed);

  return (
    <>
      <Figures cols={5}>
        <Figure icon={UsersRound} label="Pelanggan" value={num(d.customers)} sub={`${num(d.active_services)} dari ${num(d.total_services)} layanan aktif`} to="/customers"/>
        <Figure icon={Wifi} tone="purple" label="MRR (estimasi)" value={compactIdr(d.mrr_estimate)} sub="Dari layanan berstatus aktif" to="/services"/>
        <Figure icon={Wallet} tone="blue" label="Pembayaran bulan ini" value={compactIdr(d.revenue_month)} sub="Pembayaran tercatat" to={'/payments?month=' + period}/>
        <Figure icon={Receipt} tone="amber" label="Piutang terbuka" value={compactIdr(ar.total)} sub={`${num(d.unpaid_invoices)} invoice belum lunas`} to="/receivables"/>
        <Figure icon={CalendarClock} label="Lewat jatuh tempo" value={compactIdr(ar.overdue)} sub={`${num(d.overdue_invoices)} invoice`} tone={ar.overdue ? 'risk' : ''} to="/invoices?state=overdue"/>
      </Figures>

      <Section title="Umur piutang" sub="Sisa tagihan dikelompokkan menurut hari sejak jatuh tempo" actions={<Link className="link-btn" to="/receivables">Rincian per pelanggan <ArrowUpRight size={13}/></Link>} flush>
        <AgingStrip summary={ar}/>
      </Section>

      <div className="split">
        <Section title={'Penagihan periode ' + fmtPeriod(period)} sub="Invoice yang terbit untuk periode berjalan">
          <div className="collection">
            <div className="collection-rate"><strong>{rate}<small>%</small></strong><span>tertagih</span></div>
            <div className="meter" aria-label={`Tertagih ${rate}%`}><i style={{width: rate + '%'}}/></div>
            <dl className="kv">
              <div><dt>Ditagihkan</dt><dd>{idr(current.billed)}</dd></div>
              <div><dt>Diterima</dt><dd>{idr(current.collected)}</dd></div>
              <div><dt>Sisa</dt><dd>{idr(current.billed - current.collected)}</dd></div>
              <div><dt>Invoice terbuka</dt><dd>{num(current.open)} dari {num(current.count)}</dd></div>
            </dl>
          </div>
        </Section>
        <Section title="MRR per jenis layanan" sub="Estimasi kontrak bulanan, bukan pembayaran diterima">
          <table className="bars">
            <tbody>
              {Object.entries(categories).map(([cat, label]) => {
                const amount = d.revenue_by_category?.find(x => x.category === cat)?.amount || 0;
                return (
                  <tr key={cat}>
                    <th scope="row">{label}</th>
                    <td className="bar-cell"><span className="bar"><i style={{width: amount / maxCategory * 100 + '%'}}/></span></td>
                    <td className="a-num">{idr(amount)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><th scope="row">Total</th><td/><td className="a-num">{idr(d.mrr_estimate)}</td></tr></tfoot>
          </table>
        </Section>
      </div>

      <div className="split">
        <Section title="Antrean onboarding" sub="Ticket yang belum Closed" actions={<Link className="link-btn" to="/tickets">Ticketing <ArrowUpRight size={13}/></Link>}>
          {Object.keys(pipeline).length ? (
            <ul className="pipeline">
              {Object.keys(ticketStatusNames).filter(s => pipeline[s]).map(s => (
                <li key={s}><Link to={'/tickets?status=' + s}><TicketBadge status={s}/><b>{num(pipeline[s])}</b></Link></li>
              ))}
            </ul>
          ) : <Empty title="Tidak ada ticket berjalan"/>}
        </Section>
        <Section title="Invoice terbaru" actions={<Link className="link-btn" to="/invoices">Semua invoice <ArrowUpRight size={13}/></Link>}>
          {d.recent_invoices?.length ? (
            <table className="mini">
              <tbody>
                {d.recent_invoices.map(i => (
                  <tr key={i.id} className="clickable" onClick={() => navigate('/invoices/' + i.id)}>
                    <td><Link to={'/invoices/' + i.id} className="mono strong" onClick={e => e.stopPropagation()}>{i.number}</Link><div className="sub">{i.customer_name}</div></td>
                    <td className="hide-sm">{fmtDate(i.due_date)}</td>
                    <td className="a-num">{idr(i.total)}</td>
                    <td><InvoiceStatus state={invoiceState(i)}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty title="Belum ada invoice" desc="Buat pelanggan, paket, dan aktifkan layanan, kemudian generate invoice."/>}
        </Section>
      </div>
    </>
  );
}
