import React, {lazy, Suspense} from 'react';
import {Link, Route, Routes} from 'react-router-dom';
import Layout from './components/Layout.jsx';
import {Loading, PageHeader} from './components/ui.jsx';
import {useAuth} from './lib/auth.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const CustomerAccount = lazy(() => import('./pages/CustomerAccount.jsx'));
const Tickets = lazy(() => import('./pages/Tickets.jsx'));
const Services = lazy(() => import('./pages/Services.jsx'));
const Invoices = lazy(() => import('./pages/Invoices.jsx'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail.jsx'));
const Payments = lazy(() => import('./pages/Payments.jsx'));
const Receivables = lazy(() => import('./pages/Receivables.jsx'));
const Catalog = lazy(() => import('./pages/Catalog.jsx'));
const Network = lazy(() => import('./pages/Network.jsx'));
const PppProfiles = lazy(() => import('./pages/PppProfiles.jsx'));
const PppUsers = lazy(() => import('./pages/PppUsers.jsx'));
const Telegram = lazy(() => import('./pages/Telegram.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Noc = lazy(() => import('./pages/Noc.jsx'));

function NotFound() {
  return <><PageHeader title="Halaman tidak ditemukan"/><Link className="link-btn" to="/">Kembali ke Dashboard</Link></>;
}

export default function App() {
  const {session} = useAuth();
  if (!session) return <Login/>;
  if (session.role === 'noc') return <Suspense fallback={<Loading/>}><Noc/></Suspense>;
  return (
    <Routes>
      <Route element={<Layout/>}>
        <Route index element={<Dashboard/>}/>
        <Route path="customers" element={<Customers/>}/>
        <Route path="customers/:id" element={<CustomerAccount/>}/>
        <Route path="tickets" element={<Tickets/>}/>
        <Route path="services" element={<Services/>}/>
        <Route path="invoices" element={<Invoices/>}/>
        <Route path="invoices/:id" element={<InvoiceDetail/>}/>
        <Route path="payments" element={<Payments/>}/>
        <Route path="receivables" element={<Receivables/>}/>
        <Route path="catalog" element={<Catalog/>}/>
        <Route path="network" element={<Network/>}/>
        <Route path="network/profiles" element={<PppProfiles/>}/>
        <Route path="network/users" element={<PppUsers/>}/>
        <Route path="telegram" element={<Telegram/>}/>
        <Route path="settings" element={<Settings/>}/>
        <Route path="*" element={<NotFound/>}/>
      </Route>
    </Routes>
  );
}
