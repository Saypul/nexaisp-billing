import React from 'react';
import {ArrowUpRight} from 'lucide-react';
import {useApiMutation, useTelegram, useTeams} from '../api/hooks.js';
import {Alert, Button, Details, Field, PageHeader, QueryGate, Section} from '../components/ui.jsx';
import {categories, teamNames} from '../lib/format.js';

const commands = [
  ['/chatid', 'Lihat Chat ID grup untuk konfigurasi'],
  ['/pickup WO-000001', 'Ambil WO Open dari grup tim terkait'],
  ['/id', 'Lihat Telegram User ID Anda'],
  ['/wo', 'Lihat daftar WO aktif'],
  ['/status WO-000001 survey Catatan', 'Teknisi: survey → instalasi → siap; NOC: langsung siap'],
  ['Tombol Catatan / Foto', 'Tekan tombol pada pesan WO, lalu balas dengan teks, foto, atau foto dengan caption'],
  ['/note WO-000001 Catatan pekerjaan', 'Cadangan untuk catatan teks'],
];

export default function Telegram() {
  const telegram = useTelegram();
  const teams = useTeams();
  const save = useApiMutation();

  const submit = e => {
    e.preventDefault();
    const form = e.currentTarget;
    const raw = Object.fromEntries(new FormData(form));
    const body = {
      admin_chat_id: raw.admin_chat_id ? Number(raw.admin_chat_id) : null,
      work_order_chat_id: raw.work_order_chat_id ? Number(raw.work_order_chat_id) : null,
      noc_chat_id: raw.noc_chat_id ? Number(raw.noc_chat_id) : null,
      category_teams: Object.fromEntries(Object.keys(categories).map(cat => [cat, raw['team_' + cat]])),
    };
    if (raw.bot_token?.trim()) body.bot_token = raw.bot_token.trim();
    save.mutate({path: '/telegram', method: 'PUT', body, success: 'Konfigurasi Telegram tersimpan'}, {onSuccess: () => { form.elements.bot_token.value = ''; }});
  };

  return (
    <>
      <PageHeader eyebrow="Integrasi · Work order" title="Telegram & Otomasi" description="WO dikirim otomatis ke grup Teknisi atau NOC sesuai kategori layanan."/>
      <QueryGate queries={[telegram]}>
        {() => {
          const t = telegram.data;
          return (
            <div className="split">
              <Section title={t.bot_username ? '@' + t.bot_username : 'Bot belum terhubung'} sub={t.configured ? 'Bot aktif untuk polling Work Order' : 'Masukkan token dari BotFather untuk menghubungkan bot'}>
                <Details entries={[
                  ['Bot ID', t.bot_id], ['Chat ID Admin', t.admin_chat_id], ['Grup Teknisi', t.work_order_chat_id], ['Grup NOC', t.noc_chat_id],
                  ...Object.entries(categories).map(([cat, label]) => ['Rute ' + label, teamNames[teams[cat]]]),
                  ['Notifikasi WO', t.notification_mode === 'n8n' ? 'Melalui n8n' : 'Langsung melalui bot'],
                ]}/>
              </Section>
              <Section title="Konfigurasi" sub="Hanya administrator yang dapat menyimpan token bot">
                <form onSubmit={submit} key={`${t.admin_chat_id}-${t.work_order_chat_id}-${t.noc_chat_id}-${JSON.stringify(t.category_teams)}`}>
                  <Alert tone="error">{save.error?.message}</Alert>
                  <Field label="Token BotFather" name="bot_token" type="password" autoComplete="off" required={!t.configured}
                    placeholder={t.configured ? 'Kosongkan jika tidak mengganti token' : '123456789:AA...'}
                    hint="Diverifikasi ke Telegram, disimpan terenkripsi, dan tidak ditampilkan kembali."/>
                  <Field label="Chat ID Admin" name="admin_chat_id" type="number" min="1" defaultValue={t.admin_chat_id || ''} placeholder="Opsional, salinan update teknisi"/>
                  <div className="grid-2">
                    <Field label="Chat ID Grup Teknisi" name="work_order_chat_id" type="number" max="-1" defaultValue={t.work_order_chat_id || ''} placeholder="-1001234567890"/>
                    <Field label="Chat ID Grup NOC" name="noc_chat_id" type="number" max="-1" defaultValue={t.noc_chat_id || ''} placeholder="-1009876543210"/>
                  </div>
                  <div className="grid-2">
                    {Object.entries(categories).map(([cat, label]) => (
                      <Field key={cat} label={'Tim untuk ' + label} name={'team_' + cat} defaultValue={teams[cat]}>
                        <option value="technician">Teknisi · survey & instalasi</option>
                        <option value="noc">NOC · setting konfigurasi</option>
                      </Field>
                    ))}
                  </div>
                  <p className="fineprint">Tambahkan bot ke kedua grup, kirim /chatid di masing-masing grup, lalu isi ID negatifnya. Mengubah rute tim mengalihkan WO yang sedang berjalan.</p>
                  <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Menyimpan…' : 'Simpan Konfigurasi'}</Button>
                </form>
              </Section>
            </div>
          );
        }}
      </QueryGate>
      <div className="split">
        <Section title="n8n Automation" sub="Editor workflow pada server ini" actions={<a className="btn secondary small" href={`http://${window.location.hostname}:5679`} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14}/> Buka n8n</a>}>
          <p className="prose">Workflow “NexaISP Work Order to Telegram” mengirim notifikasi WO bila <code>N8N_WO_WEBHOOK_URL</code> diatur pada backend.</p>
        </Section>
        <Section title="Perintah tim WO" sub="Tombol pada pesan WO; perintah teks tetap tersedia sebagai cadangan">
          <dl className="commands">{commands.map(([c, d]) => <div key={c}><dt><code>{c}</code></dt><dd>{d}</dd></div>)}</dl>
        </Section>
      </div>
    </>
  );
}
