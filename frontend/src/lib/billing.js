// Turunan data billing yang dihitung di klien dari respons API.
import {daysBetween, todayDate} from './format.js';

export function invoiceState(invoice, today = todayDate()) {
  if (invoice.status === 'paid' || invoice.remaining <= 0) return 'paid';
  if (invoice.due_date < today) return 'overdue';
  return invoice.paid > 0 ? 'partial' : 'unpaid';
}

export const daysPastDue = (invoice, today = todayDate()) =>
  invoice.remaining > 0 ? Math.max(0, daysBetween(invoice.due_date, today)) : 0;

export const agingBuckets = [
  {key: 'current', label: 'Belum jatuh tempo', short: 'Belum JT'},
  {key: 'd30', label: '1–30 hari', short: '1–30'},
  {key: 'd60', label: '31–60 hari', short: '31–60'},
  {key: 'd90', label: '61–90 hari', short: '61–90'},
  {key: 'd90p', label: 'Lebih dari 90 hari', short: '> 90'},
];

export function agingKey(invoice, today = todayDate()) {
  const days = daysBetween(invoice.due_date, today);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'd90p';
}

const emptyBuckets = () => Object.fromEntries(agingBuckets.map(b => [b.key, 0]));

// Ringkasan piutang: total per bucket umur dan rincian per pelanggan.
export function receivables(invoices, today = todayDate()) {
  const buckets = Object.fromEntries(agingBuckets.map(b => [b.key, {amount: 0, count: 0}]));
  const byCustomer = new Map();
  let total = 0;
  for (const inv of invoices) {
    if (inv.remaining <= 0) continue;
    const key = agingKey(inv, today);
    buckets[key].amount += inv.remaining;
    buckets[key].count += 1;
    total += inv.remaining;
    let row = byCustomer.get(inv.customer_id);
    if (!row) {
      row = {id: inv.customer_id, customer_name: inv.customer_name, open: 0, total: 0, oldest_due: inv.due_date, ...emptyBuckets()};
      byCustomer.set(inv.customer_id, row);
    }
    row[key] += inv.remaining;
    row.total += inv.remaining;
    row.open += 1;
    if (inv.due_date < row.oldest_due) row.oldest_due = inv.due_date;
  }
  const overdue = total - buckets.current.amount;
  return {buckets, total, overdue, customers: [...byCustomer.values()]};
}

// Layanan yang sudah melewati aktivasi ticket (sama dengan aturan menu Layanan Aktif sebelumnya).
export function activatedServices(subscriptions, tickets) {
  const openTicketServices = new Set(tickets.filter(t => t.status !== 'closed' && t.subscription_id).map(t => t.subscription_id));
  return subscriptions.filter(s => s.status !== 'pending' && !openTicketServices.has(s.id));
}

// Agregat per pelanggan untuk daftar pelanggan dan halaman akun.
export function customerRollups(subscriptions, invoices, tickets, today = todayDate()) {
  const map = new Map();
  const get = id => {
    let r = map.get(id);
    if (!r) {
      r = {services: 0, active: 0, mrr: 0, outstanding: 0, overdue: 0, invoices: 0, paid: 0, openTickets: 0, tickets: 0, latestTicket: null, invoicedServices: new Set()};
      map.set(id, r);
    }
    return r;
  };
  for (const s of subscriptions) {
    const r = get(s.customer_id);
    r.services += 1;
    if (s.status === 'active') { r.active += 1; r.mrr += s.monthly_fee || 0; }
  }
  for (const inv of invoices) {
    const r = get(inv.customer_id);
    r.invoices += 1;
    r.paid += inv.paid;
    r.outstanding += Math.max(0, inv.remaining);
    if (inv.remaining > 0 && inv.due_date < today) r.overdue += inv.remaining;
  }
  for (const t of tickets) {
    const r = get(t.customer_id);
    r.tickets += 1;
    if (t.status !== 'closed') r.openTickets += 1;
    // Ticket berjalan diprioritaskan, lalu ticket terbaru (API mengurutkan id menurun).
    if (!r.latestTicket || (r.latestTicket.status === 'closed' && t.status !== 'closed')) r.latestTicket = t;
  }
  return map;
}

export const invoicedServiceIds = invoices => new Set(invoices.flatMap(i => i.items.map(item => item.subscription_id)));

// Mutasi rekening pelanggan: invoice sebagai debit, pembayaran sebagai kredit.
export function statement(invoices) {
  const entries = [];
  for (const inv of invoices) {
    entries.push({key: 'i' + inv.id, date: inv.due_date, sort: inv.due_date + 'a', kind: 'invoice', ref: inv.number, invoice_id: inv.id, description: 'Invoice periode ' + inv.period, debit: inv.total, credit: 0});
    for (const p of inv.payments) {
      const date = String(p.paid_at).slice(0, 10);
      entries.push({key: 'p' + p.id, date, sort: date + 'b', kind: 'payment', ref: p.reference || '—', invoice_id: inv.id, description: 'Pembayaran ' + inv.number, method: p.method, debit: 0, credit: p.amount});
    }
  }
  entries.sort((a, b) => a.sort.localeCompare(b.sort));
  let balance = 0;
  for (const e of entries) { balance += e.debit - e.credit; e.balance = balance; }
  return entries;
}

export const flattenPayments = invoices => invoices.flatMap(inv => inv.payments.map(p => ({
  ...p, invoice_id: inv.id, invoice_number: inv.number, customer_id: inv.customer_id, customer_name: inv.customer_name, period: inv.period,
})));
