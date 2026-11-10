import {ClipboardList, FileCheck, FileText, Gauge, KeyRound, Layers3, LayoutDashboard, LifeBuoy, Network, Receipt, Router, Send, Settings, UsersRound, Wallet, Wifi} from 'lucide-react';

// Struktur navigasi admin: [path, label, ikon].
export const navGroups = [
  ['Operasional', [
    ['/', 'Dashboard', LayoutDashboard],
    ['/customers', 'Pelanggan', UsersRound],
    ['/tickets', 'Ticketing', ClipboardList],
    ['/services', 'Layanan Aktif', Wifi],
    ['/complaints', 'Laporan Gangguan', LifeBuoy],
  ]],
  ['Keuangan', [
    ['/invoices', 'Invoice', Receipt],
    ['/payments', 'Pembayaran', Wallet],
    ['/payment-proofs', 'Bukti Transfer', FileCheck],
    ['/receivables', 'Piutang & Aging', FileText],
  ]],
  ['Konfigurasi', [
    ['/catalog', 'Katalog Layanan', Layers3],
    ['/network', 'Network & RADIUS', Router],
    ['/network/pools', 'IP Pool', Network],
    ['/network/profiles', 'PPP Profile', Gauge],
    ['/network/users', 'PPP User', KeyRound],
    ['/telegram', 'Telegram', Send],
    ['/settings', 'Pengaturan', Settings],
  ]],
];
