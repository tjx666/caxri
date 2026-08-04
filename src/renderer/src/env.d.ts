/// <reference types="vite/client" />

import type { CaxriBridge } from '../../shared/contracts';

declare global {
    interface Window {
        caxri: CaxriBridge;
    }
}

export {};
