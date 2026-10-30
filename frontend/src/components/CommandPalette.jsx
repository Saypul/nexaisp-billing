import React, {useMemo, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useCustomers, useInvoices, useSubscriptions, useTickets} from '../api/hooks.js';
import {idr, invoiceStateNames, ticketStatusNames} from '../lib/format.js';
import {invoiceState} from '../lib/billing.js';
import {navGroups} from '../lib/nav.js';
import {Dialog} from './ui.jsx';

const LIMIT = 6;

function match(query, ...fields) {
  return fields.some(f => f && String(f).toLowerCase().includes(query));
}

export default function CommandPalette({onClose}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const customers = useCustomers().data || [];
  const invoices = useInvoices().data || [];
  const services = useSubscriptions().data || [];
  const tickets = useTickets().data || [];

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages = navGroups.flatMap(([group, items]) => items.map(item => [group, ...item])).filter(([, , label]) => !q || label.toLowerCase().includes(q)).map(([group, to, label]) => ({group: 'Halaman', key: 'p' + to, title: label, meta: group, to}));
    if (!q) return pages;
    const take = (group, list, fn) => list.slice(0, LIMIT).map(fn).map(r => ({group, ...r}));
    return [
      ...pages,
      ...take('Pelanggan', customers.filter(c => match(q, c.name, c.code, c.email, c.phone)), c => ({key: 'c' + c.id, title: c.name, meta: c.code, to: '/customers/' + c.id})),
      ...take('Invoice', invoices.filter(i => match(q, i.number, i.customer_name)), i => ({key: 'i' + i.id, title: i.number, meta: `${i.customer_name} · ${idr(i.remaining)} · ${invoiceStateNames[invoiceState(i)]}`, to: '/invoices/' + i.id})),
      ...take('Layanan', services.filter(s => match(q, s.code, s.circuit_id, s.customer_name)), s => ({key: 's' + s.id, title: s.code, meta: `${s.customer_name} · ${s.plan_name}${s.circuit_id ? ' · ' + s.circuit_id : ''}`, to: '/customers/' + s.customer_id + '?tab=services'})),
      ...take('Ticket / WO', tickets.filter(t => match(q, t.code, t.work_order_code, t.customer_name)), t => ({key: 't' + t.id, title: `${t.work_order_code} · ${t.code}`, meta: `${t.customer_name} · ${ticketStatusNames[t.status]}`, to: '/tickets?q=' + encodeURIComponent(t.code)})),
    ];
  }, [query, customers, invoices, services, tickets]);

  const go = r => { onClose(); navigate(r.to); };
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active]); }
  };

  let lastGroup = null;
  return (
    <Dialog title="Pencarian global" onClose={onClose} size="palette">
      <div className="palette">
        <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey}
          placeholder="Nama pelanggan, ID pelanggan, nomor invoice, service ID, circuit ID, WO…" aria-label="Kata kunci pencarian"
          role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={results[active] ? 'pr-' + results[active].key : undefined}/>
        <ul id="palette-results" role="listbox">
          {results.map((r, index) => {
            const header = r.group !== lastGroup ? <li className="palette-group" role="presentation" key={'g' + r.group}>{r.group}</li> : null;
            lastGroup = r.group;
            return [header, (
              <li key={r.key} id={'pr-' + r.key} role="option" aria-selected={index === active} className={index === active ? 'active' : ''}
                onMouseEnter={() => setActive(index)} onMouseDown={e => { e.preventDefault(); go(r); }}>
                <b>{r.title}</b><span>{r.meta}</span>
              </li>
            )];
          })}
          {!results.length && <li className="palette-empty">Tidak ada hasil untuk “{query}”.</li>}
        </ul>
        <div className="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> pilih · <kbd>Enter</kbd> buka · <kbd>Esc</kbd> tutup</div>
      </div>
    </Dialog>
  );
}
