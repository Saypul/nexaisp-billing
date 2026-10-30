import React, {Suspense, useEffect, useState} from 'react';
import {NavLink, Outlet, useLocation} from 'react-router-dom';
import {useQueryClient, useIsFetching} from '@tanstack/react-query';
import {Activity, LogOut, Menu, RefreshCw, Search, X} from 'lucide-react';
import {useAuth} from '../lib/auth.jsx';
import {useHealth} from '../api/hooks.js';
import CommandPalette from './CommandPalette.jsx';
import {navGroups} from '../lib/nav.js';
import {Loading} from './ui.jsx';

export function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><Activity size={20}/></span><span><strong>nexa<span>ISP</span></strong><small>Billing System</small></span></div>;
}

export default function Layout() {
  const {session, logout} = useAuth();
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const health = useHealth({staleTime: 300_000});
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      <a href="#main" className="skip">Lewati ke konten</a>
      <aside className={'sidebar ' + (navOpen ? 'open' : '')} aria-label="Navigasi utama">
        <div className="sidebar-top">
          <Brand/>
          <button type="button" className="icon-btn only-mobile" onClick={() => setNavOpen(false)} aria-label="Tutup menu"><X size={18}/></button>
        </div>
        <nav>
          {navGroups.map(([group, items]) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {items.map(([to, label, Icon]) => (
                <NavLink key={to} to={to} end={to === '/' || to === '/network'} className="nav-link"><Icon size={17} aria-hidden="true"/>{label}</NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who"><span>{session.email || 'Administrator'}</span><small>Admin · API {health.data?.version || '—'}</small></div>
          <button type="button" className="btn ghost small" onClick={() => logout()}><LogOut size={14}/> Keluar</button>
        </div>
      </aside>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)}/>}

      <div className="workspace">
        <header className="topbar">
          <button type="button" className="icon-btn only-mobile" onClick={() => setNavOpen(true)} aria-label="Buka menu"><Menu size={19}/></button>
          <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)}>
            <Search size={15}/><span>Cari pelanggan, invoice, service ID, WO…</span><kbd>Ctrl K</kbd>
          </button>
          <button type="button" className="icon-btn" onClick={() => qc.invalidateQueries()} aria-label="Muat ulang data" title="Muat ulang data">
            <RefreshCw size={17} className={fetching ? 'spin' : ''}/>
          </button>
        </header>
        <main id="main" className="main">
          <Suspense fallback={<Loading/>}><Outlet/></Suspense>
        </main>
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)}/>}
    </div>
  );
}
