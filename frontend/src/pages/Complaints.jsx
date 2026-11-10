import React, {useMemo, useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api/client.js';
import {useApiMutation} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {Alert, Details, Dialog, Field, Figure, Figures, FormActions, PageHeader, QueryGate} from '../components/ui.jsx';
import {complaintCategoryNames, complaintStatusNames, fmtDateTime, num} from '../lib/format.js';

const tone = {open: 'overdue', in_progress: 'unpaid', resolved: 'paid'};
const ComplaintStatus = ({status}) => <span className={'mark mark-' + tone[status]}><i aria-hidden="true"/>{complaintStatusNames[status]}</span>;

const facets = [
  {id: 'status', title: 'Status', value: r => r.status, options: Object.entries(complaintStatusNames)},
  {id: 'category', title: 'Jenis', value: r => r.category, options: Object.entries(complaintCategoryNames)},
];

export default function Complaints() {
  const complaints = useQuery({queryKey: ['complaints'], queryFn: () => api('/complaints')});
  const [selected, setSelected] = useState(null);
  const columns = useMemo(() => [
    col('code', 'Nomor', r => r.code, {cell: r => <span className="mono strong">{r.code}</span>}),
    col('created_at', 'Dilaporkan', r => r.created_at, {cell: r => fmtDateTime(r.created_at)}),
    col('customer', 'Pelanggan', r => r.customer_name, {cell: r => <><Link to={'/customers/' + r.customer_id} onClick={e => e.stopPropagation()}>{r.customer_name}</Link><div className="sub">{r.customer_phone || r.customer_code}</div></>}),
    col('service', 'Layanan', r => r.service_code, {cell: r => r.service_code ? <span className="mono">{r.service_code}</span> : <span className="faint">—</span>}),
    col('category', 'Jenis', r => complaintCategoryNames[r.category]),
    col('description', 'Keluhan', r => r.description, {cell: r => <span className="wrap">{r.description}</span>}),
    col('status', 'Status', r => r.status, {cell: r => <ComplaintStatus status={r.status}/>}),
    actionsCol(r => <button type="button" className="link-btn" onClick={() => setSelected(r)}>Tanggapi</button>),
  ], []);

  return (
    <>
      <PageHeader eyebrow="Operasional · Aplikasi pelanggan" title="Laporan Gangguan"
        description="Keluhan yang dikirim pelanggan dari aplikasi. Tanggapan dan status terlihat langsung oleh pelanggan."/>
      <QueryGate queries={[complaints]}>
        {() => {
          const rows = complaints.data;
          const count = s => rows.filter(r => r.status === s).length;
          return <>
            <Figures cols={3}>
              <Figure label="Baru" value={num(count('open'))} sub="Belum ditangani" tone={count('open') ? 'risk' : ''}/>
              <Figure tone="blue" label="Sedang ditangani" value={num(count('in_progress'))}/>
              <Figure tone="green" label="Selesai" value={num(count('resolved'))}/>
            </Figures>
            <DataTable id="complaints" data={rows} columns={columns} facets={facets} exportName="laporan-gangguan"
              onRowClick={setSelected} rowLabel={r => 'Tanggapi ' + r.code}
              searchPlaceholder="Cari nomor, pelanggan, layanan, keluhan…" emptyTitle="Belum ada laporan gangguan"/>
          </>;
        }}
      </QueryGate>
      {selected && <ComplaintForm complaint={selected} onClose={() => setSelected(null)}/>}
    </>
  );
}

function ComplaintForm({complaint, onClose}) {
  const save = useApiMutation();
  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    save.mutate({path: '/complaints/' + complaint.id, method: 'PUT', body: {status: raw.status, reply: raw.reply.trim() || null}, success: 'Laporan diperbarui'}, {onSuccess: onClose});
  };
  return (
    <Dialog title={'Laporan ' + complaint.code} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <Details entries={[
          ['Pelanggan', `${complaint.customer_name} · ${complaint.customer_code}`], ['Telepon', complaint.customer_phone],
          ['Layanan', complaint.service_code], ['Alamat layanan', complaint.service_address],
          ['Jenis', complaintCategoryNames[complaint.category]], ['Dilaporkan', fmtDateTime(complaint.created_at)],
          ['Keluhan', complaint.description],
        ]}/>
        <Field label="Status" name="status" defaultValue={complaint.status}>
          {Object.entries(complaintStatusNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Field>
        <Field label="Tanggapan untuk pelanggan" name="reply" as="textarea" maxLength={2000} defaultValue={complaint.reply || ''}
          placeholder="Contoh: Teknisi menuju lokasi hari ini pukul 14.00"/>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel="Simpan"/>
      </form>
    </Dialog>
  );
}
