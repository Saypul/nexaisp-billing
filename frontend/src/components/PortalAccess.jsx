import React, {useState} from 'react';
import {useApiMutation} from '../api/hooks.js';
import {useConfirm} from './feedback.jsx';
import {Alert, Button, Details, Dialog, Field, FormActions} from './ui.jsx';

// Aktifkan/reset login aplikasi pelanggan. Password otomatis hanya ditampilkan sekali.
export default function PortalAccess({customer, onClose}) {
  const save = useApiMutation();
  const revoke = useApiMutation();
  const confirm = useConfirm();
  const [issued, setIssued] = useState(null);

  const submit = e => {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get('password').trim();
    save.mutate({path: `/customers/${customer.id}/portal-access`, method: 'PUT', body: {password: password || null},
      success: customer.portal_enabled ? 'Password aplikasi direset' : 'Akses aplikasi diaktifkan'},
      {onSuccess: r => setIssued({code: r.customer_code, password: r.password || password})});
  };

  const disable = async () => {
    if (!await confirm({title: 'Cabut akses aplikasi?', body: `${customer.name} tidak bisa login lagi dan semua sesi di HP-nya langsung keluar.`, danger: true, confirmLabel: 'Cabut'})) return;
    revoke.mutate({path: `/customers/${customer.id}/portal-access`, method: 'DELETE', success: 'Akses aplikasi dicabut'}, {onSuccess: onClose});
  };

  if (issued) return (
    <Dialog title="Login Aplikasi Pelanggan" onClose={onClose}>
      <div className="dialog-body">
        <Alert tone="info">Berikan data ini ke pelanggan. Password tidak bisa dilihat lagi setelah jendela ini ditutup.</Alert>
        <Details entries={[['ID pelanggan', <span className="mono strong">{issued.code}</span>], ['Password', <span className="mono strong">{issued.password}</span>]]}/>
        <div className="form-actions"><Button onClick={onClose}>Selesai</Button></div>
      </div>
    </Dialog>
  );

  return (
    <Dialog title={'Akses Aplikasi · ' + customer.name} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message || revoke.error?.message}</Alert>
        <p className="fineprint">
          {customer.portal_enabled
            ? 'Akses aktif. Reset password bila pelanggan lupa; sesi lama di HP pelanggan otomatis keluar.'
            : 'Pelanggan login ke aplikasi dengan ID pelanggan dan password ini untuk melihat tagihan, mengirim bukti transfer, dan melapor gangguan.'}
        </p>
        <Field label="Password baru" name="password" maxLength={128} autoComplete="off"
          hint="Kosongkan agar dibuat otomatis. Minimal 8 karakter, dengan angka, huruf kapital, atau simbol."/>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={customer.portal_enabled ? 'Reset Password' : 'Aktifkan Akses'}/>
        {customer.portal_enabled && <Button variant="ghost" className="danger" onClick={disable} disabled={revoke.isPending}>Cabut akses aplikasi</Button>}
      </form>
    </Dialog>
  );
}
