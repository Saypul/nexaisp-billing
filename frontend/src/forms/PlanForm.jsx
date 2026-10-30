import React from 'react';
import {useApiMutation} from '../api/hooks.js';
import {useConfirm} from '../components/feedback.jsx';
import {Alert, Dialog, Field, FormActions} from '../components/ui.jsx';
import {categories} from '../lib/format.js';

export default function PlanForm({plan, linked = 0, onClose}) {
  const save = useApiMutation();
  const confirm = useConfirm();

  const submit = async e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      name: raw.name, category: raw.category, description: raw.description || null,
      monthly_fee: Number(raw.monthly_fee), setup_fee: Number(raw.setup_fee || 0),
      bandwidth_mbps: raw.bandwidth_mbps ? Number(raw.bandwidth_mbps) : null,
      pppoe_profile: raw.pppoe_profile?.trim() || null,
    };
    if (plan && linked) {
      const ok = await confirm({title: 'Ubah paket yang sedang dipakai?', body: `Paket ini dipakai ${linked} layanan. Harga baru hanya menjadi nilai awal layanan baru; harga layanan yang sudah ada tetap.`, confirmLabel: 'Simpan Perubahan'});
      if (!ok) return;
    }
    save.mutate(
      {path: plan ? '/plans/' + plan.id : '/plans', method: plan ? 'PUT' : 'POST', body: plan ? {...body, confirm_existing: linked > 0} : body, success: plan ? 'Paket layanan diperbarui' : 'Paket layanan dibuat'},
      {onSuccess: onClose},
    );
  };

  return (
    <Dialog title={plan ? 'Edit Paket Layanan' : 'Paket Layanan Baru'} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <Field label="Nama Paket / Produk" name="name" required minLength={2} maxLength={120} placeholder="Contoh: Metro-E 1 Gbps" defaultValue={plan?.name || ''}/>
        <div className="grid-2">
          <Field label="Jenis Layanan" name="category" required defaultValue={plan?.category || 'METRO_E'}>
            {Object.entries(categories).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Field>
          <Field label="Bandwidth (Mbps)" name="bandwidth_mbps" type="number" min="1" placeholder="Kosongkan bila custom" defaultValue={plan?.bandwidth_mbps ?? ''}/>
        </div>
        <div className="grid-2">
          <Field label="MRC / Bulan (Rp)" name="monthly_fee" type="number" min="0" required defaultValue={plan?.monthly_fee ?? ''}/>
          <Field label="OTC Registrasi & Instalasi (Rp)" name="setup_fee" type="number" min="0" defaultValue={plan?.setup_fee ?? 0}/>
        </div>
        <Field label="PPP Profile MikroTik" name="pppoe_profile" maxLength={80} defaultValue={plan?.pppoe_profile || ''} placeholder="default"
          hint="Nama profile (rate-limit) di router untuk layanan PPPoE paket ini. Kosong = profile default."/>
        <Field label="Deskripsi" name="description" as="textarea" defaultValue={plan?.description || ''}/>
        {plan && linked > 0 && <Alert>Dipakai {linked} layanan. Harga baru menjadi nilai awal untuk layanan baru; harga layanan aktif tidak berubah.</Alert>}
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={plan ? 'Simpan Perubahan' : 'Buat Paket'}/>
      </form>
    </Dialog>
  );
}
