import React, {useState} from 'react';
import {useApiMutation, usePlans} from '../api/hooks.js';
import {Alert, Dialog, Field, FormActions} from '../components/ui.jsx';
import {kinds} from '../lib/format.js';
import {PlanSelect, ServiceTermsFields, serviceTermsPayload} from './ServiceTerms.jsx';

export default function CustomerForm({customer, onClose, onSaved}) {
  const plans = usePlans().data || [];
  const save = useApiMutation();
  const [planId, setPlanId] = useState('');
  const plan = plans.find(p => p.id === Number(planId));

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {name: raw.name, kind: raw.kind, email: raw.email || null, phone: raw.phone || null, address: raw.address || null};
    if (!customer && raw.plan_id) body.initial_service = serviceTermsPayload(raw);
    save.mutate(
      {path: customer ? '/customers/' + customer.id : '/customers', method: customer ? 'PUT' : 'POST', body,
        success: body.initial_service ? 'Pelanggan dan layanan pertama tersimpan' : 'Data pelanggan tersimpan'},
      {onSuccess: data => { onClose(); onSaved?.(data); }},
    );
  };

  return (
    <Dialog title={customer ? 'Edit Pelanggan' : 'Pelanggan Baru'} onClose={onClose} size="lg">
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <div className="grid-2">
          <Field label="ID Pelanggan" defaultValue={customer?.code || 'Dibuat otomatis (10 digit)'} readOnly/>
          <Field label="Jenis Pelanggan" name="kind" required defaultValue={customer?.kind || 'residential'}>
            {Object.entries(kinds).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Field>
        </div>
        <Field label="Nama / Perusahaan" name="name" required minLength={2} maxLength={150} defaultValue={customer?.name || ''}/>
        <div className="grid-2">
          <Field label="Email" name="email" type="email" defaultValue={customer?.email || ''} hint="Dipakai untuk penagihan"/>
          <Field label="No. Telepon" name="phone" maxLength={60} defaultValue={customer?.phone || ''}/>
        </div>
        <Field label="Alamat Penagihan" name="address" as="textarea" defaultValue={customer?.address || ''}/>
        {!customer && (
          <fieldset className="subform">
            <legend>Layanan pertama <span>opsional · layanan berikutnya dibuat dari Ticketing</span></legend>
            <PlanSelect plans={plans} value={planId} onChange={e => setPlanId(e.target.value)} emptyLabel="Tanpa layanan"/>
            {!plans.length && <Alert>Buat paket di Katalog Layanan agar bisa memilih layanan pertama.</Alert>}
            {plan && <ServiceTermsFields plan={plan}/>}
            {plan && <p className="fineprint">Service ID dibuat otomatis. Layanan masuk Ticketing sebagai pending; OTC ditagih sekali pada invoice pertama.</p>}
          </fieldset>
        )}
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={customer ? 'Simpan Perubahan' : 'Simpan Pelanggan'}/>
      </form>
    </Dialog>
  );
}
