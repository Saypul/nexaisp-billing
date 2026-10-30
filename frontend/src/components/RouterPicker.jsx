import React from 'react';
import {Link, useSearchParams} from 'react-router-dom';
import {useRouters} from '../api/hooks.js';
import {Alert, Loading} from './ui.jsx';

// Router aktif untuk halaman PPP disimpan di URL (?router=ID) agar bisa dibagikan/di-bookmark.
export function useSelectedRouter() {
  const routers = useRouters();
  const [params, setParams] = useSearchParams();
  const enabled = (routers.data || []).filter(r => r.enabled);
  const selected = enabled.find(r => String(r.id) === params.get('router')) || enabled[0] || null;
  const select = id => setParams(prev => { const next = new URLSearchParams(prev); next.set('router', id); return next; }, {replace: true});
  return {routers, enabled, selected, select};
}

export default function RouterPicker({state}) {
  const {routers, enabled, selected, select} = state;
  if (routers.isPending) return <Loading/>;
  if (!enabled.length) return <Alert>Belum ada router aktif. <Link className="link-btn" to="/network">Tambahkan router di Network & RADIUS</Link></Alert>;
  return (
    <div className="router-picker">
      <label htmlFor="router-picker">Router</label>
      <select id="router-picker" value={selected?.id || ''} onChange={e => select(e.target.value)}>
        {enabled.map(r => <option key={r.id} value={r.id}>{r.name} · {r.host}{r.identity ? ` (${r.identity})` : ''}</option>)}
      </select>
      {selected?.last_error && <span className="risk">Error terakhir: {selected.last_error}</span>}
    </div>
  );
}
