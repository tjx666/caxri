/// <reference types="vite/client" />

import type { CaxriBridge } from '@caxri/protocol';
import type { ProcessExplorerBridge } from '@desktop-shared/process-explorer';

declare global {
    interface Window {
        caxri: CaxriBridge;
        processExplorer: ProcessExplorerBridge;
    }

    // Renderer code accesses these through `globalThis` (unicorn/prefer-global-this), which is
    // not typed by the `Window` interface augmentation above on its own — these `var` declarations
    // give `globalThis.caxri`/`globalThis.processExplorer` the same real types instead of `any`.
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var caxri: CaxriBridge;
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var processExplorer: ProcessExplorerBridge;
}

export {};
