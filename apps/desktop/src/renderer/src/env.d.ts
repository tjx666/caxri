/// <reference types="vite/client" />

import type { CaxriBridge } from '@caxri/protocol';
import type {
    PerformanceMonitorHostBridge,
    PerformanceMonitorWindowBridge,
} from '@desktop-shared/performance-monitor';
import type { ProcessExplorerBridge } from '@desktop-shared/process-explorer';

declare global {
    const __CAXRI_REACT_PROFILING__: boolean;

    interface Window {
        /**
         * This worktree's absolute checkout path, set only by `switch-worktree dev`; undefined for a packaged install
         * or a bare `bun run dev`. See issue caxri#1016.
         */
        __caxriWorktree?: string;
        caxri: CaxriBridge;
        /**
         * Present in the Workbench preload only; absent in the dedicated windows and in unit tests.
         */
        performanceMonitorHost?: PerformanceMonitorHostBridge;
        /**
         * Present in the Performance Monitor window's preload only.
         */
        performanceMonitor: PerformanceMonitorWindowBridge;
        processExplorer: ProcessExplorerBridge;
    }

    // Renderer code accesses these through `globalThis` (unicorn/prefer-global-this), which is
    // not typed by the `Window` interface augmentation above on its own; these `var` declarations
    // give `globalThis.caxri`/`globalThis.processExplorer` the same real types instead of `any`.
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var __caxriWorktree: string | undefined;
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var caxri: CaxriBridge;
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var processExplorer: ProcessExplorerBridge;
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var performanceMonitor: PerformanceMonitorWindowBridge;
    // eslint-disable-next-line no-var -- `declare global { var … }` is the required ambient form
    var performanceMonitorHost: PerformanceMonitorHostBridge | undefined;
}

export {};
