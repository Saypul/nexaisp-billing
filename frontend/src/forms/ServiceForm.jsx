import React from 'react';
import {useApiMutation, useCustomers, usePlans} from '../api/hooks.js';
import {Alert, Dialog, Field, FormActions} from '../components/ui.jsx';
import {idr, serviceStatusNames} from '../lib/format.js';
import {useNetworkResultToast} from './NetworkForm.jsx';
import {PlanSelect} from './ServiceTerms.jsx';

// Edit layanan aktif. Field yang dikunci backend setelah layanan masuk invoice ikut dikunci di sini.
export default function ServiceForm({service, invoiced, onClose}) {
  const customers = useCustomers().data || [];
  const plans = usePlans().data || [];
  const save = useApiMutation();
  const showResult = useNetworkResultToast();

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      code: raw.code,
      customer_id: Number(raw.customer_id ?? service.customer_id),
      plan_id: Number(raw.plan_id),
      billing_type: raw.billing_type ?? service.billing_type,
      invoice_mode: raw.invoice_mode ?? service.invoice_mode,
      status: raw.status,
      monthly_fee: Number(raw.monthly_fee),
      setup_fee: Number(raw.setup_fee),
      start_date: raw.start_date ?? service.start_date,
      circuit_id: raw.circuit_id || null,
      service_address: raw.service_address || null,
    };
    save.mutate({path: '/subscriptions/' + service.id, method: 'PUT', body, success: 'Layanan diperbarui'}, {onSuccess: data => { showResult(data.network_result); onClose(); }});
  };

  return (
    <Dialog title={'Edit Layanan ' + service.code} onClose={onClose} size="lg">
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        {invoiced && <Alert>Layanan sudah masuk invoice: pelanggan, mode billing, cara invoice, dan tanggal aktivasi dikunci.</Alert>}
        <div className="grid-2">
          <Field label="Service ID" name="code" required minLength={2} maxLength={50} defaultValue={service.code}/>
          <Field label="Pelanggan" name="customer_id" required defaultValue={String(service.customer_id)} disabled={invoiced}>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
          </Field>
        </div>
        <PlanSelect plans={plans} required defaultValue={String(service.plan_id)} emptyLabel="Pilih paket"/>
        <div className="grid-3">
          <Field label="Mode Billing" name="billing_type" required defaultValue={service.billing_type} disabled={invoiced}>
            <option value="prepaid">Prepaid · bulan berjalan</option>
            <option value="postpaid">Postpaid · bulan sebelumnya</option>
          </Field>
          <Field label="Pembuatan Invoice" name="invoice_mode" required defaultValue={service.invoice_mode} disabled={invoiced}>
            <option value="manual">Manual</option>
            <option value="auto">Otomatis setiap bulan</option>
          </Field>
          <Field label="Status" name="status" required defaultValue={service.status}>
            {Object.entries(serviceStatusNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Field>
        </div>
        <div className="grid-3">
          <Field label="MRC / Bulan (Rp)" name="monthly_fee" type="number" min="0" required defaultValue={service.monthly_fee} hint={'Saat ini ' + idr(service.monthly_fee)}/>
          <Field label="OTC (Rp)" name="setup_fee" type="number" min="0" required defaultValue={service.setup_fee}/>
          <Field label="Tanggal Aktivasi" name="start_date" type="date" required defaultValue={service.start_date} disabled={invoiced}/>
        </div>
        <div className="grid-2">
          <Field label="Circuit ID / VLAN / Tunnel" name="circuit_id" maxLength={100} defaultValue={service.circuit_id || ''}/>
          <Field label="Alamat Titik Layanan" name="service_address" defaultValue={service.service_address || ''}/>
        </div>
        <p className="fineprint">Status hanya menandai layanan untuk billing; tidak mengubah konfigurasi router atau RADIUS.</p>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel="Simpan Perubahan"/>
      </form>
    </Dialog>
  );
}
