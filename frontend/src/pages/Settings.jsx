import React, {useState} from 'react';
import {Plus} from 'lucide-react';
import {useApiMutation, useBankAccounts, useHealth, useNocUsers} from '../api/hooks.js';
import {useConfirm} from '../components/feedback.jsx';
import {Alert, Button, Checkbox, Dialog, Field, FormActions, PageHeader, QueryGate, Section} from '../components/ui.jsx';

const modules = [
  ['Autentikasi', 'JWT 8 jam, password Argon2; peran Admin dan NOC', 'Aktif'],
  ['Database', 'PostgreSQL 16 dengan volume Docker persisten', 'Aktif'],
  ['Aturan billing', 'MRC bulanan, OTC sekali, prepaid/postpaid, invoice manual atau otomatis', 'Aktif'],
  ['Pembayaran', 'Pencatatan manual (transfer, cash, QRIS manual)', 'Aktif'],
  ['Payment gateway', 'Settlement otomatis', 'Belum tersedia'],
  ['Pajak, diskon, prorata', 'Perhitungan pada invoice', 'Belum tersedia'],
  ['Provisioning PPPoE', 'MikroTik RouterOS API: PPP secret, isolir manual & otomatis', 'Aktif'],
  ['RADIUS / OLT', 'FreeRADIUS, provisioning ONT/OLT', 'Belum tersedia'],
  ['Notifikasi pelanggan', 'WhatsApp dan email', 'Belum tersedia'],
];

export default function Settings() {
  const users = useNocUsers();
  const health = useHealth();
  const create = useApiMutation();

  const submit = e => {
    e.preventDefault();
    const form = e.currentTarget;
    const raw = Object.fromEntries(new FormData(form));
    create.mutate({path: '/users/noc', body: {email: raw.email, password: raw.password}, success: 'Akun NOC dibuat'}, {onSuccess: () => form.reset()});
  };

  return (
    <>
      <PageHeader eyebrow="System configuration" title="Pengaturan" description={'Akun operator dan status modul. Versi API ' + (health.data?.version || '—') + '.'}/>
      <BankAccounts/>
      <div className="split">
        <Section title="Akun NOC" sub="NOC memverifikasi WO Siap Aktivasi dan menetapkan tanggal mulai billing">
          <form onSubmit={submit}>
            <Alert tone="error">{create.error?.message}</Alert>
            <Field label="Email NOC" name="email" type="email" required autoComplete="off"/>
            <Field label="Password" name="password" type="password" minLength={8} maxLength={128} required autoComplete="new-password" hint="Minimal 8 karakter, dengan angka, huruf kapital, atau simbol"/>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Membuat…' : 'Buat Akun NOC'}</Button>
          </form>
          <QueryGate queries={[users]}>
            {() => (
              <table className="mini">
                <thead><tr><th>Akun NOC terdaftar ({users.data.length})</th></tr></thead>
                <tbody>{users.data.length ? users.data.map(u => <tr key={u.id}><td>{u.email}</td></tr>) : <tr><td className="faint">Belum ada</td></tr>}</tbody>
              </table>
            )}
          </QueryGate>
        </Section>
        <Section title="Modul sistem">
          <table className="mini">
            <thead><tr><th>Modul</th><th>Cakupan</th><th>Status</th></tr></thead>
            <tbody>{modules.map(([name, desc, status]) => <tr key={name}><td className="strong">{name}</td><td>{desc}</td><td className={status === 'Aktif' ? '' : 'faint'}>{status}</td></tr>)}</tbody>
          </table>
        </Section>
      </div>
    </>
  );
}

function BankAccounts() {
  const accounts = useBankAccounts();
  const remove = useApiMutation();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const destroy = async a => {
    if (!await confirm({title: 'Hapus rekening?', body: `${a.bank_name} ${a.account_number} tidak lagi tampil di aplikasi pelanggan.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/bank-accounts/' + a.id, method: 'DELETE', success: 'Rekening dihapus'});
  };
  return (
    <Section title="Rekening Pembayaran" sub="Rekening aktif tampil di aplikasi pelanggan pada rincian tagihan dan saat mengirim bukti transfer"
      actions={<Button variant="secondary" icon={Plus} onClick={() => setEditing({})}>Tambah Rekening</Button>}>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      <QueryGate queries={[accounts]}>
        {() => accounts.data.length ? (
          <table className="mini">
            <thead><tr><th>Bank</th><th>Nomor rekening</th><th>Atas nama</th><th>Keterangan</th><th>Status</th><th/></tr></thead>
            <tbody>{accounts.data.map(a => (
              <tr key={a.id}>
                <td className="strong">{a.bank_name}</td><td className="mono">{a.account_number}</td><td>{a.account_holder}</td>
                <td>{a.note || <span className="faint">—</span>}</td>
                <td className={a.active ? '' : 'faint'}>{a.active ? 'Tampil' : 'Disembunyikan'}</td>
                <td className="a-num">
                  <button type="button" className="link-btn" onClick={() => setEditing(a)}>Edit</button>{' '}
                  <button type="button" className="link-btn danger" onClick={() => destroy(a)}>Hapus</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="fineprint">Belum ada rekening. Pelanggan belum melihat tujuan transfer di aplikasi.</p>}
      </QueryGate>
      {editing && <BankForm account={editing.id ? editing : null} onClose={() => setEditing(null)}/>}
    </Section>
  );
}

function BankForm({account, onClose}) {
  const save = useApiMutation();
  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {bank_name: raw.bank_name.trim(), account_number: raw.account_number.trim(), account_holder: raw.account_holder.trim(),
      note: raw.note.trim() || null, sort_order: Number(raw.sort_order || 0), active: raw.active === 'on'};
    save.mutate({path: account ? '/bank-accounts/' + account.id : '/bank-accounts', method: account ? 'PUT' : 'POST', body,
      success: account ? 'Rekening diperbarui' : 'Rekening ditambahkan'}, {onSuccess: onClose});
  };
  return (
    <Dialog title={account ? 'Edit Rekening' : 'Tambah Rekening'} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <div className="grid-2">
          <Field label="Nama bank" name="bank_name" required minLength={2} maxLength={80} defaultValue={account?.bank_name || ''} placeholder="BCA"/>
          <Field label="Nomor rekening" name="account_number" required minLength={4} maxLength={40} pattern="[0-9 \-]+" inputMode="numeric"
            defaultValue={account?.account_number || ''} hint="Angka, spasi, atau tanda minus"/>
        </div>
        <Field label="Atas nama" name="account_holder" required minLength={2} maxLength={120} defaultValue={account?.account_holder || ''}/>
        <div className="grid-2">
          <Field label="Keterangan (opsional)" name="note" maxLength={200} defaultValue={account?.note || ''} placeholder="Contoh: KCP Bogor"/>
          <Field label="Urutan tampil" name="sort_order" type="number" min={0} max={999} defaultValue={account?.sort_order ?? 0} hint="Angka kecil tampil lebih dulu"/>
        </div>
        <Checkbox label="Tampilkan di aplikasi pelanggan" name="active" defaultChecked={account ? account.active : true}/>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={account ? 'Simpan' : 'Tambah'}/>
      </form>
    </Dialog>
  );
}
