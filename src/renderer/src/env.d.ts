/// <reference types="vite/client" />

import type { CaxriBridge } from '../../shared/ipc';
import type { ProcessExplorerBridge } from '../../shared/process-explorer';

declare global {
    interface Window {
        caxri: CaxriBridge;
        processExplorer: ProcessExplorerBridge;
    }
}

export {};
