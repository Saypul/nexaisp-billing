// Label, format, dan aturan tampilan yang dipakai lintas halaman.

export const categories = {METRO_E: 'Metro-E Corporate', DEDICATED: 'Dedicated Internet', FTTH: 'FTTH', TUNNEL: 'Tunnel'};
export const defaultTeams = {METRO_E: 'technician', DEDICATED: 'technician', FTTH: 'technician', TUNNEL: 'noc'};
export const teamNames = {technician: 'Teknisi', noc: 'NOC'};
export const kinds = {residential: 'Residential', business: 'Business', corporate: 'Corporate'};
export const billingNames = {prepaid: 'Prepaid', postpaid: 'Postpaid'};
export const invoiceModeNames = {manual: 'Manual', auto: 'Otomatis'};
export const ticketStatusNames = {scheduled: 'Terjadwal RFS', open: 'Open', survey: 'Survey', installation: 'Instalasi', ready: 'Siap Aktivasi', closed: 'Closed'};
export const serviceStatusNames = {active: 'Aktif', pending: 'Pending', suspended: 'Suspended', terminated: 'Terminasi'};
export const invoiceStateNames = {paid: 'Lunas', partial: 'Dibayar Sebagian', unpaid: 'Belum Bayar', overdue: 'Lewat Jatuh Tempo'};
export const paymentMethodNames = {transfer: 'Transfer Bank', cash: 'Cash', qris_manual: 'QRIS (manual)', other: 'Lainnya'};
export const chargeTypeNames = {mrc: 'MRC', otc: 'OTC'};
export const networkStateNames = {unconfigured: 'Belum dipetakan', provisioned: 'Terpasang', isolated: 'Diisolir', error: 'Gagal sinkron'};
export const isolationReasonNames = {manual: 'manual', overdue: 'tunggakan'};
export const networkActionNames = {
  test: 'Tes koneksi', provision: 'Provisioning', isolate: 'Isolir', restore: 'Buka isolir', assign: 'Pemetaan',
  unassign: 'Lepas pemetaan', reveal: 'Lihat kredensial', policy: 'Kebijakan isolir', router_create: 'Router ditambah',
  router_update: 'Router diubah', router_delete: 'Router dihapus', profile_create: 'Profile dibuat',
  profile_update: 'Profile diubah', profile_delete: 'Profile dihapus', secret_create: 'User PPP dibuat',
  secret_update: 'User PPP diubah', secret_delete: 'User PPP dihapus', disconnect: 'Putus sesi',
};

export const ticketSteps = team => team === 'noc' ? ['open', 'ready', 'closed'] : ['scheduled', 'open', 'survey', 'installation', 'ready', 'closed'];

const idrFormat = new Intl.NumberFormat('id-ID');
export const idr = n => 'Rp' + idrFormat.format(Number(n || 0));
export const num = n => idrFormat.format(Number(n || 0));
export const compactIdr = n => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e9) return 'Rp' + (v / 1e9).toLocaleString('id-ID', {maximumFractionDigits: 2}) + ' M';
  if (Math.abs(v) >= 1e6) return 'Rp' + (v / 1e6).toLocaleString('id-ID', {maximumFractionDigits: 1}) + ' jt';
  return idr(v);
};
export const percent = (part, whole) => whole ? Math.round(part / whole * 100) : 0;

// Tanggal lokal dalam format ISO (YYYY-MM-DD) sehingga dapat dibandingkan sebagai string.
export const todayDate = () => new Date().toLocaleDateString('sv-SE');
export const todayPeriod = () => todayDate().slice(0, 7);
export const fmtDate = v => v ? new Date(v.length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('id-ID', {day: '2-digit', month: 'short', year: 'numeric'}) : '—';
export const fmtDateTime = v => v ? new Date(v).toLocaleString('id-ID', {day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'}) : '—';
export const fmtPeriod = p => {
  if (!p) return '—';
  const [y, m] = p.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('id-ID', {month: 'short', year: 'numeric'});
};
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
