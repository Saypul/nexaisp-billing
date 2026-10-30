import React, {useState} from 'react';
import {Brand} from '../components/Layout.jsx';
import {Alert, Button} from '../components/ui.jsx';
import {useAuth} from '../lib/auth.jsx';

export default function Login() {
  const {login, notice} = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const submit = async e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    setPending(true);
    setError('');
    try { await login({email: raw.email, password: raw.password}); }
    catch (err) { setError(err.message); setPending(false); }
  };

  return (
    <main className="login">
      <section className="login-intro">
        <Brand/>
        <h1>Billing multi-layanan ISP</h1>
        <p>Metro-E Corporate, Dedicated Internet, FTTH, dan Tunnel — pelanggan, work order, invoice, dan piutang dalam satu sistem.</p>
      </section>
      <section className="login-form">
        <h2>Masuk</h2>
        <form onSubmit={submit}>
          {notice && !error && <Alert>{notice}</Alert>}
          <Alert tone="error">{error}</Alert>
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required autoFocus/></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required/></div>
          <Button type="submit" className="block" disabled={pending}>{pending ? 'Memeriksa…' : 'Masuk'}</Button>
        </form>
        <p className="fineprint">Akses untuk akun Admin dan NOC. Sesi berlaku 8 jam.</p>
      </section>
    </main>
  );
}
