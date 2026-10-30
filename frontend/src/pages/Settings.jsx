import React from 'react';
import {useApiMutation, useHealth, useNocUsers} from '../api/hooks.js';
import {Alert, Button, Field, PageHeader, QueryGate, Section} from '../components/ui.jsx';

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
      <div className="split">
        <Section title="Akun NOC" sub="NOC memverifikasi WO Siap Aktivasi dan menetapkan tanggal mulai billing">
          <form onSubmit={submit}>
            <Alert tone="error">{create.error?.message}</Alert>
            <Field label="Email NOC" name="email" type="email" required autoComplete="off"/>
            <Field label="Password" name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" hint="Minimal 12 karakter"/>
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
