import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

/**
 * Server-state defaults tuned for a local-IPC app rather than a network API: there is no other
 * client to race with over `window.caxri`, so a background window-focus refetch only doubles
 * Runtime work, and an IPC rejection is a real failure (a bad path, a closed Session) rather than a
 * transient network blip worth retrying. Individual queries override `staleTime` where a shorter or
 * longer window makes sense (see `queries/client.ts` call sites).
 */
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchOnWindowFocus: false,
            retry: 0,
            staleTime: 10_000,
        },
        mutations: {
            retry: 0,
        },
    },
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
        </QueryClientProvider>
    </StrictMode>,
);
