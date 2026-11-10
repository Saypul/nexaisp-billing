import React, {useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Plus} from 'lucide-react';
import {api} from '../api/client.js';
import {useApiMutation} from '../api/hooks.js';
import DataTable, {actionsCol, col} from '../components/DataTable.jsx';
import {useConfirm} from '../components/feedback.jsx';
import RouterPicker, {useSelectedRouter} from '../components/RouterPicker.jsx';
import {Alert, Button, Dialog, Field, Figure, Figures, FormActions, PageHeader, QueryGate} from '../components/ui.jsx';
import {num} from '../lib/format.js';

export default function IpPools() {
  const picker = useSelectedRouter();
  const router = picker.selected;
  const pools = useQuery({queryKey: ['routers', router?.id, 'pools'], queryFn: () => api(`/routers/${router.id}/pools`), enabled: Boolean(router), retry: false});
  const remove = useApiMutation();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);

  const destroy = async p => {
    if (!await confirm({title: 'Hapus IP pool?', body: `Pool “${p.name}” (${p.ranges}) akan dihapus dari router ${router.name}.`, danger: true, confirmLabel: 'Hapus'})) return;
    remove.mutate({path: `/routers/${router.id}/pools/${encodeURIComponent(p.id)}`, method: 'DELETE', success: 'IP pool dihapus dari router'});
  };

  const columns = useMemo(() => [
    col('name', 'Nama', r => r.name, {cell: r => <span className="mono strong">{r.name}</span>}),
    col('ranges', 'Range', r => r.ranges, {cell: r => <span className="mono wrap">{r.ranges.split(',').join(', ')}</span>}),
    col('size', 'Kapasitas', r => r.size, {align: 'num', cell: r => num(r.size)}),
    col('used', 'IP terpakai', r => r.used, {align: 'num', cell: r => <>{num(r.used)}{r.size > 0 && <div className="sub">{Math.round(r.used / r.size * 100)}%</div>}</>}),
    col('next', 'Next pool', r => r.next_pool, {cell: r => r.next_pool ? <span className="mono">{r.next_pool}</span> : <span className="faint">—</span>}),
    col('gateway', 'Saran gateway', r => r.gateway, {hidden: true}),
    col('used_by', 'Dipakai oleh', r => r.used_by.join(', '), {cell: r => r.used_by.length ? <span className="wrap">{r.used_by.join(', ')}</span> : <span className="faint">—</span>}),
    col('comment', 'Komentar', r => r.comment, {hidden: true}),
    actionsCol(r => <>
      <button type="button" className="link-btn" onClick={() => setDialog({pool: r})}>Edit</button>
      <button type="button" className="link-btn danger" onClick={() => destroy(r)} disabled={r.used > 0 || r.used_by.length > 0}
        title={r.used_by.length ? `Dipakai ${r.used_by.join(', ')}` : r.used ? `${r.used} IP sedang dipakai` : 'Hapus'}>Hapus</button>
    </>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [router?.id]);

  return (
    <>
      <PageHeader eyebrow="Konfigurasi · MikroTik" title="IP Pool"
        description="Pool alamat IP untuk user PPPoE dan DHCP. Data dibaca langsung dari router; pool dipilih di kolom Remote address pada PPP Profile."
        actions={<Button icon={Plus} disabled={!router} onClick={() => setDialog({})}>Pool Baru</Button>}/>
      <RouterPicker state={picker}/>
      <Alert tone="error" onDismiss={remove.reset}>{remove.error?.message}</Alert>
      {router && (
        <QueryGate queries={[pools]}>
          {() => {
            const size = pools.data.reduce((s, p) => s + p.size, 0);
            const used = pools.data.reduce((s, p) => s + p.used, 0);
            return <>
              <Figures cols={3}>
                <Figure label="IP pool" value={num(pools.data.length)} sub={router.name}/>
                <Figure tone="blue" label="Total kapasitas" value={num(size)} sub="Alamat IP"/>
                <Figure tone="amber" label="IP terpakai" value={num(used)} sub={size ? `${Math.round(used / size * 100)}% dari kapasitas` : '—'}/>
              </Figures>
              <DataTable id="ip-pools" syncUrl={false} data={pools.data} columns={columns} exportName={'ip-pool-' + router.name}
                searchPlaceholder="Cari nama pool atau range…" emptyTitle="Belum ada IP pool"/>
            </>;
          }}
        </QueryGate>
      )}
      {dialog && router && <PoolForm router={router} pool={dialog.pool} pools={pools.data || []} onClose={() => setDialog(null)}/>}
    </>
  );
}

function PoolForm({router, pool, pools, onClose}) {
  const save = useApiMutation();
  const locked = pool && pool.used_by.length > 0;

  const submit = e => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    const body = {name: raw.name ?? pool.name, ranges: raw.ranges.trim(), next_pool: raw.next_pool || null, comment: raw.comment.trim() || null};
    save.mutate({
      path: pool ? `/routers/${router.id}/pools/${encodeURIComponent(pool.id)}` : `/routers/${router.id}/pools`,
      method: pool ? 'PUT' : 'POST', body, success: pool ? 'IP pool diperbarui di router' : 'IP pool dibuat di router',
    }, {onSuccess: onClose});
  };

  return (
    <Dialog title={(pool ? 'Edit Pool ' + pool.name : 'IP Pool Baru') + ' · ' + router.name} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <Alert tone="error">{save.error?.message}</Alert>
        <Field label="Nama pool" name="name" required maxLength={80} pattern="[A-Za-z0-9._\-]+" defaultValue={pool?.name || ''}
          disabled={locked} placeholder="pool-ftth" hint={locked ? `Tidak bisa diganti: dipakai ${pool.used_by.join(', ')}` : 'Huruf, angka, titik, garis bawah, atau tanda minus'}/>
        <Field label="Range IP" name="ranges" required maxLength={500} defaultValue={pool?.ranges || ''} placeholder="10.20.0.2-10.20.0.254"
          hint="Format a-b atau CIDR (10.20.0.0/24). Beberapa range dipisah koma. Sisakan IP gateway di luar range."/>
        <Field label="Next pool" name="next_pool" defaultValue={pool?.next_pool || ''} hint="Dipakai saat pool ini penuh">
          <option value="">Tidak ada</option>
          {pools.filter(p => p.name !== pool?.name).map(p => <option key={p.id} value={p.name}>{p.name} · {p.ranges}</option>)}
        </Field>
        <Field label="Komentar" name="comment" maxLength={200} defaultValue={pool?.comment || ''}/>
        <FormActions onCancel={onClose} pending={save.isPending} submitLabel={pool ? 'Simpan ke Router' : 'Buat di Router'}/>
      </form>
    </Dialog>
  );
}
