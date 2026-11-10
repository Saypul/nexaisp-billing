import React, {useCallback, useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Activity, Check, ChevronLeft, ChevronRight, Copy, Home, ImagePlus, LifeBuoy, LogOut, Receipt, User} from 'lucide-react';
import {api, setToken, setUnauthorizedHandler} from '../api/client.js';
import {invoiceState} from '../lib/billing.js';
import {
  categories, daysBetween, todayDate, complaintCategoryNames, complaintStatusNames, fmtDate, fmtDateTime, fmtPeriod, idr, invoiceStateNames,
  networkStateNames, paymentMethodNames, proofStatusNames, serviceStatusNames,
} from '../lib/format.js';

const TOKEN_KEY = 'nx_portal_token';
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: v => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* sesi hanya di memori */ } },
};

export default function PortalApp() {
  const qc = useQueryClient();
  const [token, setSession] = useState(() => { const t = store.get(); setToken(t); return t; });
  const [notice, setNotice] = useState('');
  const signIn = useCallback(t => { store.set(t); setToken(t); setSession(t); setNotice(''); }, []);
  const signOut = useCallback((message = '') => { store.set(null); setToken(null); setSession(null); setNotice(message); qc.clear(); }, [qc]);
  useEffect(() => { setUnauthorizedHandler(() => signOut('Sesi berakhir. Silakan masuk kembali.')); }, [signOut]);
  return token ? <Shell signIn={signIn} signOut={signOut}/> : <Login onDone={signIn} notice={notice}/>;
}

// --- login -------------------------------------------------------------------
function Login({onDone, notice}) {
  const login = useMutation({mutationFn: body => api('/portal/login', {method: 'POST', body}), onSuccess: r => onDone(r.access_token)});
  const submit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    login.mutate({customer_code: f.customer_code.trim(), password: f.password});
  };
  return (
    <main className="p-login">
      <div className="p-brand"><img src="/logo.svg" alt="" width="40" height="40"/><b>nexa<span>ISP</span></b></div>
      <h1>Masuk</h1>
      <p className="p-muted">Gunakan ID pelanggan dan password yang diberikan petugas kami.</p>
      <form onSubmit={submit} className="p-card p-form">
        {(login.error || notice) && <p className="p-alert" role="alert">{login.error?.message || notice}</p>}
        <label>ID pelanggan<input name="customer_code" inputMode="numeric" autoComplete="username" required maxLength={40} placeholder="10 digit"/></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required/></label>
        <button className="p-btn" disabled={login.isPending}>{login.isPending ? 'Memeriksa…' : 'Masuk'}</button>
      </form>
      <p className="p-muted p-small">Belum punya akses atau lupa password? Hubungi layanan pelanggan untuk mengaktifkan atau mereset.</p>
    </main>
  );
}

// --- kerangka aplikasi -------------------------------------------------------------
const tabs = [['home', 'Beranda', Home], ['bills', 'Tagihan', Receipt], ['support', 'Gangguan', LifeBuoy], ['account', 'Akun', User]];

function Shell({signIn, signOut}) {
  const [tab, setTab] = useState('home');
  const [view, setView] = useState(null); // sub-halaman: {type: 'invoice', id} | {type: 'pay', invoice}
  const me = useQuery({queryKey: ['me'], queryFn: () => api('/portal/me')});
  const invoices = useQuery({queryKey: ['invoices'], queryFn: () => api('/portal/invoices')});
  const go = t => { setTab(t); setView(null); window.scrollTo(0, 0); };
  const open = v => { setView(v); window.scrollTo(0, 0); };

  let body;
  if (me.isPending || invoices.isPending) body = <p className="p-muted p-pad">Memuat data…</p>;
  else if (me.isError || invoices.isError) body = <ErrorBox error={me.error || invoices.error} retry={() => { me.refetch(); invoices.refetch(); }}/>;
  else if (view?.type === 'invoice') body = <InvoiceDetail invoice={invoices.data.find(i => i.id === view.id)} back={() => setView(null)} pay={inv => open({type: 'pay', invoice: inv})}/>;
  else if (view?.type === 'pay') body = <PayForm invoice={view.invoice} back={() => setView({type: 'invoice', id: view.invoice.id})} done={() => { go('bills'); }}/>;
  else if (tab === 'home') body = <HomeTab me={me.data} invoices={invoices.data} open={open} go={go}/>;
  else if (tab === 'bills') body = <BillsTab invoices={invoices.data} open={open}/>;
  else if (tab === 'support') body = <SupportTab services={me.data.services}/>;
  else body = <AccountTab me={me.data} signIn={signIn} signOut={signOut}/>;

  return (
    <div className="p-app">
      <main className="p-main">{body}</main>
      <nav className="p-tabs" aria-label="Menu utama">
        {tabs.map(([key, label, Icon]) => (
          <button key={key} type="button" className={tab === key && !view ? 'on' : tab === key ? 'sub' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => go(key)}>
            <Icon size={21} aria-hidden="true"/><span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function ErrorBox({error, retry}) {
  return <div className="p-pad"><p className="p-alert" role="alert">{error?.message || 'Data tidak dapat dimuat.'}</p><button className="p-btn ghost" onClick={retry}>Coba lagi</button></div>;
}

function StateTag({state}) {
  return <span className={'p-tag t-' + state}>{invoiceStateNames[state]}</span>;
}

// --- beranda -------------------------------------------------------------------------
function HomeTab({me, invoices, open, go}) {
  const unpaid = invoices.filter(i => i.remaining > 0).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const next = unpaid[0];
  const days = next ? daysBetween(todayDate(), next.due_date) : null;
  const firstName = me.name.split(' ')[0];
  return (
    <>
      <header className="p-hello"><span className="p-muted">Halo,</span><h1>{me.kind === 'residential' ? firstName : me.name}</h1><span className="p-id">ID {me.code}</span></header>

      <section className={'p-bill' + (next && days < 0 ? ' late' : '')} aria-label="Ringkasan tagihan">
        {next ? <>
          <span className="p-bill-label">Total tagihan belum dibayar</span>
          <strong className="p-bill-amount">{idr(me.outstanding)}</strong>
          <span className="p-bill-due">
            {days < 0 ? `Lewat jatuh tempo ${-days} hari` : days === 0 ? 'Jatuh tempo hari ini' : `Jatuh tempo ${days} hari lagi`} · {fmtDate(next.due_date)}
          </span>
          <div className="p-bill-actions">
            <button className="p-btn light" onClick={() => open({type: 'pay', invoice: next})}><ImagePlus size={17} aria-hidden="true"/>Kirim bukti transfer</button>
            <button className="p-btn outline" onClick={() => open({type: 'invoice', id: next.id})}>Rincian</button>
          </div>
          {unpaid.length > 1 && <span className="p-bill-note">{unpaid.length} invoice belum lunas</span>}
        </> : <>
          <span className="p-bill-label">Tagihan</span>
          <strong className="p-bill-amount">Lunas</strong>
          <span className="p-bill-due">Tidak ada tagihan yang perlu dibayar.</span>
        </>}
      </section>

      <h2 className="p-h2">Layanan saya</h2>
      {me.services.length ? me.services.map(s => <ServiceCard key={s.id} s={s}/>) : <p className="p-muted p-card">Belum ada layanan terdaftar.</p>}

      <button type="button" className="p-card p-row p-link" onClick={() => go('support')}>
        <LifeBuoy size={20} aria-hidden="true"/><span><b>Internet bermasalah?</b><small>Laporkan gangguan ke tim kami</small></span><ChevronRight size={18} aria-hidden="true"/>
      </button>
    </>
  );
}

function ServiceCard({s}) {
  const isolated = s.network_state === 'isolated';
  const tone = isolated || s.status === 'suspended' ? 'bad' : s.status === 'active' ? 'good' : 'warn';
  const label = isolated ? (s.isolation_reason === 'overdue' ? 'Diisolir karena tunggakan' : 'Diisolir sementara') : serviceStatusNames[s.status];
  return (
    <article className="p-card p-service">
      <div className="p-service-top"><Activity size={18} aria-hidden="true"/><b>{s.plan_name}</b><span className={'p-dot ' + tone}>{label}</span></div>
      <dl>
        <div><dt>Jenis</dt><dd>{categories[s.category] || s.category}{s.bandwidth_mbps ? ` · ${s.bandwidth_mbps} Mbps` : ''}</dd></div>
        <div><dt>Service ID</dt><dd className="mono">{s.code}</dd></div>
        <div><dt>Biaya bulanan</dt><dd>{idr(s.monthly_fee)}</dd></div>
        {s.service_address && <div><dt>Alamat</dt><dd>{s.service_address}</dd></div>}
      </dl>
      {isolated && s.isolation_reason === 'overdue' && <p className="p-hint">Layanan aktif kembali otomatis setelah tagihan lunas diverifikasi.</p>}
      {s.network_state === 'error' && <p className="p-hint">{networkStateNames.error}: tim kami sedang menyinkronkan layanan.</p>}
    </article>
  );
}

// --- tagihan ---------------------------------------------------------------------------
function BillsTab({invoices, open}) {
  const proofs = useQuery({queryKey: ['proofs'], queryFn: () => api('/portal/proofs')});
  return (
    <>
      <h1 className="p-title">Tagihan</h1>
      {invoices.length ? (
        <ul className="p-list">
          {invoices.map(i => (
            <li key={i.id}>
              <button type="button" className="p-card p-row p-link" onClick={() => open({type: 'invoice', id: i.id})}>
                <span><b>{fmtPeriod(i.period)}</b><small className="mono">{i.number}</small></span>
                <span className="p-right"><b>{idr(i.remaining > 0 ? i.remaining : i.total)}</b><StateTag state={invoiceState(i)}/></span>
                <ChevronRight size={18} aria-hidden="true"/>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="p-muted p-card">Belum ada invoice.</p>}
      {proofs.data?.length > 0 && <>
        <h2 className="p-h2">Bukti transfer terkirim</h2>
        <ul className="p-list">{proofs.data.map(p => <ProofItem key={p.id} p={p}/>)}</ul>
      </>}
    </>
  );
}

function ProofItem({p}) {
  return (
    <li className="p-card p-proof">
      <div className="p-row"><span><b>{idr(p.amount)}</b><small className="mono">{p.invoice_number} · {fmtDateTime(p.created_at)}</small></span><span className={'p-tag p-' + p.status}>{proofStatusNames[p.status]}</span></div>
      {p.status === 'rejected' && p.review_note && <p className="p-hint">Alasan: {p.review_note}</p>}
    </li>
  );
}

function InvoiceDetail({invoice, back, pay}) {
  if (!invoice) return <><BackBar back={back} title="Invoice"/><p className="p-muted">Invoice tidak ditemukan.</p></>;
  const state = invoiceState(invoice);
  return (
    <>
      <BackBar back={back} title={'Tagihan ' + fmtPeriod(invoice.period)}/>
      <section className="p-card">
        <div className="p-row"><span className="mono p-muted">{invoice.number}</span><StateTag state={state}/></div>
        <ul className="p-lines">
          {invoice.items.map((it, n) => <li key={n}><span>{it.description}</span><b>{idr(it.amount)}</b></li>)}
          <li className="sum"><span>Total</span><b>{idr(invoice.total)}</b></li>
          {invoice.paid > 0 && <li><span>Sudah dibayar</span><b>−{idr(invoice.paid)}</b></li>}
          <li className="sum"><span>Sisa tagihan</span><b>{idr(invoice.remaining)}</b></li>
        </ul>
        <p className="p-muted p-small">Jatuh tempo {fmtDate(invoice.due_date)}</p>
      </section>
      {invoice.remaining > 0 && <BankList/>}
      {invoice.remaining > 0 && <button className="p-btn" onClick={() => pay(invoice)}><ImagePlus size={17} aria-hidden="true"/>Kirim bukti transfer</button>}
      {invoice.payments.length > 0 && <>
        <h2 className="p-h2">Riwayat pembayaran</h2>
        <ul className="p-list">
          {invoice.payments.map(p => (
            <li key={p.id} className="p-card p-row"><span><b>{idr(p.amount)}</b><small>{paymentMethodNames[p.method] || p.method}</small></span><small>{fmtDateTime(p.paid_at)}</small></li>
          ))}
        </ul>
      </>}
    </>
  );
}

// Clipboard API butuh konteks aman (HTTPS); di HTTP lokal pakai cara lama lewat textarea tersembunyi.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* lanjut ke fallback */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

function BankList() {
  const banks = useQuery({queryKey: ['banks'], queryFn: () => api('/portal/bank-accounts'), staleTime: 5 * 60_000});
  const [copied, setCopied] = useState(null);
  if (!banks.data?.length) return null;
  const copy = async b => {
    if (await copyText(b.account_number.replace(/[\s-]/g, ''))) { setCopied(b.id); setTimeout(() => setCopied(c => (c === b.id ? null : c)), 2000); }
  };
  return (
    <section className="p-card p-banks" aria-label="Rekening tujuan transfer">
      <h2 className="p-h2">Transfer ke</h2>
      <ul>
        {banks.data.map(b => (
          <li key={b.id}>
            <span><small>{b.bank_name}</small><b className="mono">{b.account_number}</b><small>a.n. {b.account_holder}{b.note ? ' · ' + b.note : ''}</small></span>
            <button type="button" onClick={() => copy(b)} aria-label={'Salin nomor rekening ' + b.bank_name}>
              {copied === b.id ? <><Check size={16} aria-hidden="true"/>Tersalin</> : <><Copy size={16} aria-hidden="true"/>Salin</>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BackBar({back, title}) {
  return <div className="p-back"><button type="button" onClick={back} aria-label="Kembali"><ChevronLeft size={22}/></button><h1>{title}</h1></div>;
}

// Kecilkan foto di HP sebelum dikirim (maks. sisi 1600 px, JPEG) agar cepat dan di bawah batas server.
async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length * 0.75 < 1_100_000) return data;
  }
  throw new Error('Foto terlalu besar. Coba foto ulang dengan resolusi lebih kecil.');
}

function PayForm({invoice, back, done}) {
  const qc = useQueryClient();
  const [image, setImage] = useState(null);
  const [fileError, setFileError] = useState('');
  const send = useMutation({
    mutationFn: body => api('/portal/proofs', {method: 'POST', body}),
    onSuccess: async () => { await qc.invalidateQueries(); done(); },
  });
  const pick = async e => {
    const file = e.target.files?.[0];
    setFileError('');
    if (!file) return;
    try { setImage(await compressImage(file)); } catch (err) { setImage(null); setFileError(err.message || 'Foto tidak dapat dibaca.'); }
  };
  const submit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    send.mutate({invoice_id: invoice.id, amount: Number(f.amount), sender_name: f.sender_name.trim() || null, note: f.note.trim() || null, image_base64: image});
  };
  return (
    <>
      <BackBar back={back} title="Kirim bukti transfer"/>
      <BankList/>
      <form className="p-card p-form" onSubmit={submit}>
        <p className="p-muted p-small">Invoice <span className="mono">{invoice.number}</span> · sisa {idr(invoice.remaining)}. Pembayaran tercatat setelah diverifikasi petugas.</p>
        {(send.error || fileError) && <p className="p-alert" role="alert">{fileError || send.error.message}</p>}
        <label className="p-photo">
          {image ? <img src={image} alt="Pratinjau bukti transfer"/> : <span><ImagePlus size={28} aria-hidden="true"/>Pilih atau foto bukti transfer</span>}
          <input type="file" accept="image/*" onChange={pick}/>
        </label>
        <label>Nominal ditransfer<input name="amount" type="number" inputMode="numeric" min={1} max={invoice.remaining} required defaultValue={invoice.remaining}/></label>
        <label>Nama pemilik rekening pengirim<input name="sender_name" maxLength={120} autoComplete="name"/></label>
        <label>Catatan (opsional)<textarea name="note" maxLength={500} rows={2}/></label>
        <button className="p-btn" disabled={!image || send.isPending}>{send.isPending ? 'Mengirim…' : 'Kirim'}</button>
      </form>
    </>
  );
}

// --- gangguan ---------------------------------------------------------------------------
function SupportTab({services}) {
  const qc = useQueryClient();
  const list = useQuery({queryKey: ['complaints'], queryFn: () => api('/portal/complaints')});
  const [sent, setSent] = useState(false);
  const create = useMutation({
    mutationFn: body => api('/portal/complaints', {method: 'POST', body}),
    onSuccess: () => { qc.invalidateQueries({queryKey: ['complaints']}); setSent(true); },
  });
  const submit = e => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    create.mutate({subscription_id: f.subscription_id ? Number(f.subscription_id) : null, category: f.category, description: f.description.trim()},
      {onSuccess: () => form.reset()});
  };
  const active = services.filter(s => s.status !== 'pending');
  return (
    <>
      <h1 className="p-title">Lapor gangguan</h1>
      <form className="p-card p-form" onSubmit={submit}>
        {create.error && <p className="p-alert" role="alert">{create.error.message}</p>}
        {sent && !create.isPending && <p className="p-ok" role="status">Laporan terkirim. Kami kabari perkembangannya di bawah.</p>}
        {active.length > 0 && (
          <label>Layanan
            <select name="subscription_id" defaultValue={active[0].id}>{active.map(s => <option key={s.id} value={s.id}>{s.plan_name} · {s.code}</option>)}</select>
          </label>
        )}
        <label>Masalah
          <select name="category" defaultValue="no_internet">{Object.entries(complaintCategoryNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label>Ceritakan masalahnya<textarea name="description" required minLength={5} maxLength={2000} rows={4} placeholder="Contoh: lampu LOS di modem merah sejak pukul 08.00" onInput={() => setSent(false)}/></label>
        <button className="p-btn" disabled={create.isPending}>{create.isPending ? 'Mengirim…' : 'Kirim laporan'}</button>
      </form>
      <h2 className="p-h2">Riwayat laporan</h2>
      {list.isPending ? <p className="p-muted">Memuat…</p> : list.data?.length ? (
        <ul className="p-list">
          {list.data.map(c => (
            <li key={c.id} className="p-card p-complaint">
              <div className="p-row"><span><b>{complaintCategoryNames[c.category]}</b><small className="mono">{c.code} · {fmtDateTime(c.created_at)}</small></span><span className={'p-tag c-' + c.status}>{complaintStatusNames[c.status]}</span></div>
              <p>{c.description}</p>
              {c.reply && <p className="p-reply"><b>Tanggapan petugas</b>{c.reply}</p>}
            </li>
          ))}
        </ul>
      ) : <p className="p-muted p-card">Belum ada laporan.</p>}
    </>
  );
}

// --- akun ------------------------------------------------------------------------------
function AccountTab({me, signIn, signOut}) {
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: body => api('/portal/password', {method: 'PUT', body}),
    onSuccess: r => { signIn(r.access_token); setDone(true); },
  });
  const submit = e => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    change.mutate({current_password: f.current_password, new_password: f.new_password}, {onSuccess: () => form.reset()});
  };
  return (
    <>
      <h1 className="p-title">Akun</h1>
      <section className="p-card">
        <dl className="p-profile">
          <div><dt>Nama</dt><dd>{me.name}</dd></div>
          <div><dt>ID pelanggan</dt><dd className="mono">{me.code}</dd></div>
          {me.phone && <div><dt>Telepon</dt><dd>{me.phone}</dd></div>}
          {me.email && <div><dt>Email</dt><dd>{me.email}</dd></div>}
          {me.address && <div><dt>Alamat</dt><dd>{me.address}</dd></div>}
        </dl>
        <p className="p-muted p-small">Perubahan data kontak dilakukan melalui layanan pelanggan.</p>
      </section>
      <h2 className="p-h2">Ganti password</h2>
      <form className="p-card p-form" onSubmit={submit}>
        {change.error && <p className="p-alert" role="alert">{change.error.message}</p>}
        {done && !change.isPending && <p className="p-ok" role="status">Password diganti. Perangkat lain otomatis keluar.</p>}
        <label>Password lama<input name="current_password" type="password" autoComplete="current-password" required/></label>
        <label>Password baru<input name="new_password" type="password" autoComplete="new-password" required minLength={8} maxLength={128}/>
          <small>Minimal 8 karakter, dengan angka, huruf kapital, atau simbol.</small></label>
        <button className="p-btn" disabled={change.isPending}>Simpan password</button>
      </form>
      <button className="p-btn ghost p-out" onClick={() => signOut()}><LogOut size={18} aria-hidden="true"/>Keluar</button>
    </>
  );
}

