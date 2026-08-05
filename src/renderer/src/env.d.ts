/// <reference types="vite/client" />

import type { CaxriBridge } from '../../shared/ipc';

declare global {
    interface Window {
        caxri: CaxriBridge;
    }
}

export {};
