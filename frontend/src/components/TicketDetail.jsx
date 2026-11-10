import React from 'react';
import AuthImage from './AuthImage.jsx';
import {billingNames, categories, fmtDateTime, idr, invoiceModeNames, teamNames, ticketStatusNames} from '../lib/format.js';
import {Details, Dialog, TicketStage} from './ui.jsx';

function EventPhoto({url, status}) {
  return <AuthImage url={url} alt={'Dokumentasi tahap ' + (ticketStatusNames[status] || status)} label="Buka foto dokumentasi"/>;
}

export function TicketHistory({events = []}) {
  return (
    <section className="history">
      <h3>Riwayat Work Order</h3>
      {events.length ? (
        <ol>
          {events.map(e => (
            <li key={e.id}>
              <b>{ticketStatusNames[e.new_status] || e.new_status}</b>
              <span>{e.actor_name} · {fmtDateTime(e.created_at)}</span>
              {e.note && <p>{e.note}</p>}
              {e.photo_url && <EventPhoto url={e.photo_url} status={e.new_status}/>}
            </li>
          ))}
        </ol>
      ) : <p className="fineprint">Belum ada riwayat perubahan.</p>}
    </section>
  );
}

export function ticketEntries(t) {
  return [
    ['Work Order', t.work_order_code], ['Ticket ID', t.code],
    ['Pelanggan', `${t.customer_name} (${t.customer_code})`], ['Status', ticketStatusNames[t.status]],
    ['Paket', t.plan_name], ['Bandwidth', t.bandwidth_mbps ? t.bandwidth_mbps + ' Mbps' : null],
    ['Service ID', t.service_code], ['Kategori', categories[t.category]],
    ['Tim WO', teamNames[t.work_order_team]], ['PIC WO', t.technician_name],
    ['Mode Billing', billingNames[t.billing_type]], ['Pembuatan Invoice', invoiceModeNames[t.invoice_mode]],
    ['MRC / Bulan', t.monthly_fee == null ? null : idr(t.monthly_fee)], ['OTC', t.setup_fee == null ? null : idr(t.setup_fee)],
    ['RFS Target', t.rfs_target_date], ['Pekerjaan Siap', t.installed_at ? fmtDateTime(t.installed_at) : null],
    ['Mulai Billing', t.status === 'closed' ? t.start_date : null], ['Aktif Sejak', t.activated_at ? fmtDateTime(t.activated_at) : null],
    ['Circuit ID', t.circuit_id], ['Alamat Layanan', t.service_address],
    ['Catatan', t.notes],
  ];
}

export default function TicketDetail({ticket, onClose, actions}) {
  return (
    <Dialog title={`${ticket.work_order_code} · ${ticket.code}`} onClose={onClose} size="lg">
      <div className="dialog-body">
        <TicketStage status={ticket.status} team={ticket.work_order_team}/>
        <Details columns={2} entries={ticketEntries(ticket)}/>
        <TicketHistory events={ticket.events}/>
        {actions}
      </div>
    </Dialog>
  );
}
