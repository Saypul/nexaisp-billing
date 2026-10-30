import React, {useMemo, useState} from 'react';
import {Plus} from 'lucide-react';
import {useApiMutation, usePlans, useSubscriptions} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import {Alert, Button, Figure, Figures, PageHeader, QueryGate} from '../components/ui.jsx';
import PlanForm from '../forms/PlanForm.jsx';
import {categories, idr, num} from '../lib/format.js';

const facets = [{id: 'category', title: 'Jenis', value: r => r.category, options: Object.entries(categories)}];

export default function Catalog() {
  const plans = usePlans();
  const subs = useSubscriptions();
  const remove = useApiMutation();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);

  const usage = useMemo(() => {
    const m = new Map();
    for (const s of subs.data || []) {
      const u = m.get(s.plan_id) || {total: 0, active: 0};
      u.total += 1;
      if (s.status === 'active') u.active += 1;
      m.set(s.plan_id, u);
    }
    return m;
  }, [subs.data]);

  const destroy = async p => {
    if (!await confirm({title: 'Hapus paket?', body: `Paket “${p.name}” akan dihapus permanen.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: '/plans/' + p.id, method: 'DELETE', success: 'Paket layanan dihapus'});
  };

  const columns = useMemo(() => [
    col('name', 'Nama Paket', r => r.name, {cell: r => <><span className="strong">{r.name}</span>{r.description && <div className="sub">{r.description}</div>}</>}),
    col('category', 'Jenis', r => categories[r.category]),
    col('profile', 'PPP Profile', r => r.pppoe_profile, {cell: r => (r.pppoe_profile ? <span className="mono">{r.pppoe_profile}</span> : <span className="faint">default</span>)}),
    col('bw', 'Bandwidth', r => r.bandwidth_mbps || 0, {align: 'num', cell: r => (r.bandwidth_mbps ? num(r.bandwidth_mbps) + ' Mbps' : 'Custom')}),
    col('mrc', 'MRC / Bulan', r => r.monthly_fee, {align: 'num', cell: r => idr(r.monthly_fee)}),
    col('otc', 'OTC', r => r.setup_fee, {align: 'num', cell: r => idr(r.setup_fee)}),
    col('used', 'Dipakai', r => usage.get(r.id)?.total || 0, {align: 'num', cell: r => { const u = usage.get(r.id); return u ? `${num(u.active)} aktif / ${num(u.total)}` : <span className="faint">0</span>; }}),
    actionsCol(r => <>
      <button type="button" className="link-btn" onClick={() => setDialog({plan: r})}>Edit</button>
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={usage.has(r.id)} title={usage.has(r.id) ? 'Paket masih dipakai layanan' : 'Hapus'}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [usage]);

  return (
    <>
      <PageHeader eyebrow="Service catalog" title="Katalog Layanan" description="Harga paket adalah nilai awal MRC dan OTC untuk layanan baru; harga layanan yang sudah berjalan tidak ikut berubah."
        actions={<Button icon={Plus} onClick={() => setDialog({})}>Paket Baru</Button>}/>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      <QueryGate queries={[plans, subs]}>
        {() => <>
          <Figures cols={4}>
            {Object.entries(categories).map(([key, label]) => <Figure key={key} label={label} value={num(plans.data.filter(p => p.category === key).length)} sub="paket" to={'/catalog?category=' + key}/>)}
          </Figures>
          <DataTable id="plans" data={plans.data} columns={columns} facets={facets} exportName="katalog-layanan"
            searchText={r => [r.name, r.description, categories[r.category]].join(' ')} searchPlaceholder="Cari paket…"
            initialSort={[{id: 'category', desc: false}]}
            emptyTitle="Belum ada paket" emptyDesc="Tambah paket Metro-E Corporate, Dedicated Internet, FTTH, atau Tunnel."/>
        </>}
      </QueryGate>
      {dialog && <PlanForm plan={dialog.plan} linked={dialog.plan ? usage.get(dialog.plan.id)?.total || 0 : 0} onClose={() => setDialog(null)}/>}
    </>
  );
}
