import React, {useMemo, useState} from 'react';
import {Link} from 'react-router-dom';
import {ClipboardList} from 'lucide-react';
import {useApiMutation, useCustomers, useTickets} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import TicketDetail from '../components/TicketDetail.jsx';
import {Alert, Button, Figure, Figures, PageHeader, QueryGate, TicketBadge} from '../components/ui.jsx';
import NetworkForm from '../forms/NetworkForm.jsx';
import TicketForm from '../forms/TicketForm.jsx';
import {categories, fmtDate, num, teamNames, ticketStatusNames, todayDate} from '../lib/format.js';

const facets = [
  {id: 'status', title: 'Progres', value: r => r.status, options: Object.entries(ticketStatusNames)},
  {id: 'team', title: 'Tim', value: r => r.work_order_team, options: Object.entries(teamNames)},
  {id: 'category', title: 'Layanan', value: r => r.category, options: Object.entries(categories)},
];

export default function Tickets() {
  // Ticket diperbarui teknisi lewat Telegram, jadi halaman ini menyegarkan diri setiap 30 detik.
  const tickets = useTickets({refetchInterval: 30_000});
  const customers = useCustomers();
  const remove = useApiMutation();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);

  const destroy = async t => {
    if (!await confirm({title: 'Hapus ticket?', body: `${t.code} (${t.work_order_code}) akan dihapus. Layanan pending yang hanya terkait ticket ini ikut terhapus.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/tickets/' + t.id, method: 'DELETE', success: 'Ticket dihapus'});
  };

  const columns = useMemo(() => [
    col('wo', 'WO', r => r.work_order_code, {cell: r => <span className="mono strong">{r.work_order_code}</span>}),
    col('code', 'Ticket', r => r.code, {cell: r => <span className="mono">{r.code}</span>}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <><Link to={'/customers/' + r.customer_id} className="strong" onClick={e => e.stopPropagation()}>{r.customer_name}</Link><div className="sub mono">{r.customer_code}</div></>}),
    col('team', 'Tim', r => teamNames[r.work_order_team]),
    col('pic', 'PIC WO', r => r.technician_name, {cell: r => r.technician_name || <span className="faint">Belum diambil</span>}),
    col('plan', 'Paket', r => r.plan_name, {cell: r => r.plan_name || <span className="faint">Belum dipilih</span>}),
    col('service', 'Service ID', r => r.service_code, {hidden: true}),
    col('rfs', 'RFS Target', r => r.rfs_target_date, {cell: r => <span className={r.status !== 'closed' && r.rfs_target_date && r.rfs_target_date < todayDate() ? 'risk' : ''}>{fmtDate(r.rfs_target_date)}</span>}),
    col('status', 'Progres', r => r.status, {cell: r => <TicketBadge status={r.status} team={r.work_order_team}/>}),
    col('created', 'Dibuat', r => r.created_at, {cell: r => fmtDate(r.created_at)}),
    actionsCol(r => <>
      {r.subscription_id && <button type="button" className="link-btn" onClick={() => setDialog({type: 'network', id: r.subscription_id})}>Jaringan</button>}
      <button type="button" className="link-btn" onClick={() => setDialog({type: 'edit', ticket: r})}>Edit</button>
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={remove.isPending}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [remove.isPending]);

  return (
    <>
      <PageHeader eyebrow="Onboarding · Work order" title="Ticketing" description="Dari pendaftaran sampai aktivasi NOC. Teknisi memperbarui progres lewat Telegram; data disegarkan tiap 30 detik."
        actions={<Button icon={ClipboardList} onClick={() => setDialog({type: 'create'})} disabled={!customers.data?.length}>Ticket Baru</Button>}/>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      <QueryGate queries={[tickets]}>
        {() => {
          const list = tickets.data;
          const open = list.filter(t => t.status !== 'closed');
          return <>
            <Figures cols={4}>
              <Figure label="Ticket berjalan" value={num(open.length)}/>
              <Figure label="Siap aktivasi" value={num(list.filter(t => t.status === 'ready').length)} sub="Menunggu verifikasi NOC" to="/tickets?status=ready"/>
              <Figure label="Terjadwal RFS" value={num(list.filter(t => t.status === 'scheduled').length)} to="/tickets?status=scheduled"/>
              <Figure label="Lewat RFS target" value={num(open.filter(t => t.rfs_target_date && t.rfs_target_date < todayDate()).length)} tone={open.some(t => t.rfs_target_date && t.rfs_target_date < todayDate()) ? 'risk' : ''}/>
            </Figures>
            <DataTable id="tickets" data={list} columns={columns} facets={facets} exportName="ticket"
              searchText={r => [r.work_order_code, r.code, r.customer_name, r.customer_code, r.technician_name, r.plan_name, r.service_code, r.circuit_id].join(' ')}
              searchPlaceholder="Cari WO, ticket, pelanggan, PIC, service ID…"
              onRowClick={r => setDialog({type: 'view', id: r.id})} rowLabel={r => 'Detail ' + r.work_order_code}
              emptyTitle="Belum ada ticket" emptyDesc="Pelanggan baru otomatis dibuatkan ticket Open atau Terjadwal RFS."/>
          </>;
        }}
      </QueryGate>
      {dialog?.type === 'create' && <TicketForm onClose={() => setDialog(null)}/>}
      {dialog?.type === 'network' && <NetworkForm serviceId={dialog.id} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'edit' && <TicketForm ticket={dialog.ticket} onClose={() => setDialog(null)}/>}
      {dialog?.type === 'view' && (() => {
        const t = tickets.data?.find(x => x.id === dialog.id);
        return t ? <TicketDetail ticket={t} onClose={() => setDialog(null)} actions={<div className="dialog-actions"><Button variant="secondary" onClick={() => setDialog({type: 'edit', ticket: t})}>Edit Ticket</Button></div>}/> : null;
      })()}
    </>
  );
}
