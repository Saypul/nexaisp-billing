import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import PortalApp from './PortalApp.jsx';
import './portal.css';

const queryClient = new QueryClient({
  defaultOptions: {queries: {staleTime: 30_000, retry: (count, error) => (!error?.status || error.status >= 500) && count < 2}},
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><PortalApp/></QueryClientProvider>
  </React.StrictMode>,
);
