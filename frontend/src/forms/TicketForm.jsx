import React, {useState} from 'react';
import {useApiMutation, useCustomers, usePlans, useTeams} from '../api/hooks.js';
import {Alert, Details, Dialog, Field, FormActions, TicketStage} from '../components/ui.jsx';
import {teamNames, ticketStatusNames} from '../lib/format.js';
import {PlanSelect, ServiceTermsFields, serviceTermsPayload} from './ServiceTerms.jsx';

export default function TicketForm({ticket, customerId, onClose}) {
  const customers = useCustomers().data || [];
  const plans = usePlans().data || [];
  const teams = useTeams();
  const save = useApiMutation();
  const [planId, setPlanId] = useState(ticket?.plan_id ? String(ticket.plan_id) : '');
  const plan = plans.find(p => p.id === Number(planId));
  const samePlan = Boolean(ticket && plan && ticket.plan_id === plan.id);
  const team = plan ? teams[plan.category] : ticket?.work_order_team;
  const closed = ticket?.status === 'closed';

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    if (!ticket) {
      save.mutate({path: '/tickets', body: {customer_id: Number(raw.customer_id), initial_service: raw.plan_id ? serviceTermsPayload(raw) : null, notes: raw.notes || null}, success: 'Ticket baru dibuat'}, {onSuccess: onClose});
      return;
    }
    const service = raw.plan_id ? serviceTermsPayload(raw) : null;
    save.mutate({
      path: '/tickets/' + ticket.id, method: 'PUT', success: 'Progres ticket diperbarui',
      body: {
        status: raw.status || ticket.status,
        plan_id: service?.plan_id || null, billing_type: service?.billing_type || null, invoice_mode: service?.invoice_mode || null,
        monthly_fee: service?.monthly_fee ?? null, setup_fee: service?.setup_fee ?? null,
        rfs_target_date: raw.rfs_target_date || null, circuit_id: service?.circuit_id || null,
        service_address: service?.service_address || null, notes: raw.notes || null,
      },
    }, {onSuccess: onClose});
  };

  const title = ticket ? `Edit ${ticket.work_order_code} · ${ticket.code}` : 'Ticket Baru';
  return (
    <Dialog title={title} onClose={onClose} size="lg">
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        {ticket && <TicketStage status={ticket.status} team={team}/>}
        {ticket
          ? <Details columns={2} entries={[['Pelanggan', `${ticket.customer_name} (${ticket.customer_code})`], ['Layanan', ticket.plan_name]]}/>
          : (
            <Field label="Pelanggan" name="customer_id" required defaultValue={customerId ? String(customerId) : ''}>
              <option value="">Pilih pelanggan</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </Field>
          )}
        {closed ? (
          <p className="fineprint">Ticket sudah Closed. Layanan dikelola dari menu Layanan Aktif; hanya catatan yang dapat diubah.</p>
        ) : (
          <>
            {ticket && (
              <Field label="Status Progres" name="status" required defaultValue={ticket.status}>
                {Object.entries(ticketStatusNames).filter(([v]) => v !== 'closed' && (team !== 'noc' || ['open', 'ready'].includes(v))).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Field>
            )}
            <PlanSelect plans={plans} value={planId} onChange={e => setPlanId(e.target.value)}/>
            {!plans.length && <Alert>Buat paket di Katalog Layanan sebelum aktivasi ticket.</Alert>}
            {plan && <ServiceTermsFields plan={plan} current={samePlan ? ticket : (ticket ? {rfs_target_date: ticket.rfs_target_date} : undefined)}/>}
            <div className="callout">
              <b>Work Order {ticket?.work_order_code || '(dibuat saat ticket disimpan)'} → grup {teamNames[team] || 'Teknisi'}</b>
              <p>{team === 'noc' ? 'PIC NOC mengambil WO lewat tombol Telegram dan menyiapkan konfigurasi sampai Siap Aktivasi.' : 'Petugas teknisi mengambil WO lewat tombol Telegram lalu menjalankan survey dan instalasi.'} Layanan tetap pending sampai NOC mengaktifkan ticket.</p>
            </div>
          </>
        )}
        <Field label="Catatan Progres" name="notes" as="textarea" defaultValue={ticket?.notes || ''}/>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={ticket ? 'Simpan Progres' : 'Buat Ticket'}/>
      </form>
    </Dialog>
  );
}
