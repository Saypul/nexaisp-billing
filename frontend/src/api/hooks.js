import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {api} from './client.js';
import {useToast} from '../components/feedback.jsx';
import {defaultTeams} from '../lib/format.js';

const resource = path => (options = {}) => useQuery({queryKey: [path], queryFn: ({signal}) => api('/' + path, {signal}), ...options});

export const useCustomers = resource('customers');
export const usePlans = resource('plans');
export const useSubscriptions = resource('subscriptions');
export const useTickets = resource('tickets');
export const useInvoices = resource('invoices');
export const useDashboard = resource('dashboard');
export const useTelegram = resource('telegram');
export const useNocUsers = resource('users/noc');
export const useHealth = resource('health');
export const useRouters = resource('routers');
export const useNetworkSettings = resource('network/settings');
export const useNetworkEvents = resource('network/events');
export const useAutoIsolatePreview = resource('network/auto-isolate/preview');

export function useTeams() {
  const {data} = useTelegram();
  return {...defaultTeams, ...(data?.category_teams || {})};
}

// Mutasi generik: setiap perubahan menandai seluruh cache basi agar angka billing selalu konsisten.
export function useApiMutation() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({path, method = 'POST', body}) => api(path, {method, body}),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries();
      if (vars.success) toast(vars.success);
    },
  });
}

// Menjalankan aksi massal secara berurutan agar backend tidak dibanjiri request paralel.
export function useBulkAction() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({items, run}) => {
      const failed = [];
      let ok = 0;
      for (const item of items) {
        try { await run(item); ok += 1; } catch (err) { failed.push({item, error: err.message}); }
      }
      return {ok, failed};
    },
    onSuccess: async ({ok, failed}, vars) => {
      await qc.invalidateQueries();
      if (failed.length) toast(`${ok} berhasil, ${failed.length} gagal: ${failed[0].error}`, 'error');
      else toast(`${ok} ${vars.label}`);
    },
  });
}
