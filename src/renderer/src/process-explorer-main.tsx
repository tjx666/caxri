import './process-explorer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ProcessExplorerApp } from './features/process-explorer/ProcessExplorerApp';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ProcessExplorerApp />
    </StrictMode>,
);
