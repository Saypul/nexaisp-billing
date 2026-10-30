import {ClipboardList, FileText, Gauge, KeyRound, Layers3, LayoutDashboard, Receipt, Router, Send, Settings, UsersRound, Wallet, Wifi} from 'lucide-react';

// Struktur navigasi admin: [path, label, ikon].
export const navGroups = [
  ['Operasional', [
    ['/', 'Dashboard', LayoutDashboard],
    ['/customers', 'Pelanggan', UsersRound],
    ['/tickets', 'Ticketing', ClipboardList],
    ['/services', 'Layanan Aktif', Wifi],
  ]],
  ['Keuangan', [
    ['/invoices', 'Invoice', Receipt],
    ['/payments', 'Pembayaran', Wallet],
    ['/receivables', 'Piutang & Aging', FileText],
  ]],
  ['Konfigurasi', [
    ['/catalog', 'Katalog Layanan', Layers3],
    ['/network', 'Network & RADIUS', Router],
    ['/network/profiles', 'PPP Profile', Gauge],
    ['/network/users', 'PPP User', KeyRound],
    ['/telegram', 'Telegram', Send],
    ['/settings', 'Pengaturan', Settings],
  ]],
];
