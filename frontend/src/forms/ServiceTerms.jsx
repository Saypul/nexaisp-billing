import React from 'react';
import {Field} from '../components/ui.jsx';
import {categories, todayDate} from '../lib/format.js';

export function PlanSelect({plans, value, defaultValue, onChange, required, label = 'Paket Layanan', emptyLabel = 'Belum ditentukan'}) {
  return (
    <Field label={label} name="plan_id" required={required} defaultValue={defaultValue} value={value} onChange={onChange}>
      <option value="">{emptyLabel}</option>
      {Object.entries(categories).map(([cat, catLabel]) => {
        const list = plans.filter(p => p.category === cat);
        return list.length ? <optgroup key={cat} label={catLabel}>{list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup> : null;
      })}
    </Field>
  );
}

// Syarat komersial layanan baru: mode billing, cara invoice, MRC/OTC, RFS, circuit, dan alamat.
export function ServiceTermsFields({plan, current}) {
  const metro = plan.category === 'METRO_E';
  return (
    <div className="fieldset" key={plan.id}>
      <div className="grid-3">
        <Field label="Mode Billing" name="billing_type" required defaultValue={current?.billing_type || 'postpaid'}>
          <option value="prepaid">Prepaid · bulan berjalan</option>
          <option value="postpaid">Postpaid · bulan sebelumnya</option>
        </Field>
        <Field label="Pembuatan Invoice" name="invoice_mode" required defaultValue={current?.invoice_mode || (plan.category === 'FTTH' ? 'auto' : 'manual')}>
          <option value="manual">Manual</option>
          <option value="auto">Otomatis setiap bulan</option>
        </Field>
        <Field label="RFS Target" name="rfs_target_date" type="date" required={metro}
          defaultValue={current ? current.rfs_target_date || '' : (metro ? todayDate() : '')}
          hint={metro ? 'Metro-E > 7 hari ke depan masuk Terjadwal RFS' : undefined}/>
      </div>
      <div className="grid-2">
        <Field label="MRC / Bulan (Rp)" name="monthly_fee" type="number" min="0" step="1" required defaultValue={current?.monthly_fee ?? plan.monthly_fee}/>
        <Field label="OTC Registrasi / Instalasi (Rp)" name="setup_fee" type="number" min="0" step="1" required defaultValue={current?.setup_fee ?? plan.setup_fee}/>
      </div>
      <div className="grid-2">
        <Field label="Circuit ID / VLAN / Tunnel" name="circuit_id" defaultValue={current?.circuit_id || ''}/>
        <Field label="Alamat Titik Layanan" name="service_address" defaultValue={current?.service_address || ''}/>
      </div>
    </div>
  );
}

export const serviceTermsPayload = raw => ({
  plan_id: Number(raw.plan_id),
  billing_type: raw.billing_type,
  invoice_mode: raw.invoice_mode,
  monthly_fee: Number(raw.monthly_fee),
  setup_fee: Number(raw.setup_fee),
  rfs_target_date: raw.rfs_target_date || null,
  circuit_id: raw.circuit_id || null,
  service_address: raw.service_address || null,
});
