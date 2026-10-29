/**
 * Channels between Main, the monitored Workbench window, and the Performance Monitor window. Preload entries repeat
 * these strings as literals (a runtime import would make Rolldown share a CommonJS chunk the sandboxed preload cannot
 * require); the type-only bindings there keep each literal in lockstep with this table.
 */
export const PERFORMANCE_MONITOR_CHANNELS = {
    /**
     * Workbench to Main: one frame snapshot. Fire-and-forget; Main forwards it to the monitor window.
     */
    publish: 'caxri:performance-monitor:publish',
    /**
     * Workbench to Main (invoke): whether a detached monitor wants this window's snapshots.
     */
    isActive: 'caxri:performance-monitor:is-active',
    /**
     * Main to Workbench: start or stop publishing, or switch the monitor to the in-window overlay.
     */
    control: 'caxri:performance-monitor:control',
    /**
     * Main to monitor window: the latest frame snapshot from the monitored Workbench.
     */
    snapshot: 'caxri:performance-monitor:snapshot',
    /**
     * Main to monitor window: the monitored window's state and reload history changed.
     */
    state: 'caxri:performance-monitor:state',
    /**
     * Monitor window to Main: read current state once on startup.
     */
    getState: 'caxri:performance-monitor:get-state',
    metrics: 'caxri:performance-monitor:metrics',
    reload: 'caxri:performance-monitor:reload',
    switchToOverlay: 'caxri:performance-monitor:switch-to-overlay',
    setAlwaysOnTop: 'caxri:performance-monitor:set-always-on-top',
    theme: 'caxri:performance-monitor:theme',
    /**
     * Main to monitor window: the effective theme changed (system appearance, saved theme, or theme settings).
     */
    themeChanged: 'caxri:performance-monitor:theme-changed',
    language: 'caxri:performance-monitor:language',
    languageChanged: 'caxri:performance-monitor:language-changed',
} as const;
