import type { AppSettings } from '@caxri/protocol';

/**
 * Session-wide WebGL policy shared by every mounted Terminal. The controller is rebuilt on each tab switch, so anything
 * that must outlive a pane (the GPU incident budget, the cached WebGL2 probe) lives behind this seam.
 */
export interface TerminalWebglSessionPolicy {
    /**
     * Records the preference each pane applies; an actual change is the user's request to try WebGL again.
     */
    applyPreference(preference: AppSettings['terminal.gpuAcceleration']): void;
    isPinnedToDom(): boolean;
    isWebgl2Available(): boolean;
    /**
     * Terminal WebGL contexts currently held across every pane of this Renderer. Chromium caps a renderer process at 16
     * live WebGL contexts and silently force-loses the oldest past that, so this count is what lets a context-loss
     * diagnostic tell context pressure apart from a GPU reset or a system sleep.
     */
    liveWebglContextCount(): number;
    /**
     * Brackets one pane's WebGL context: called once after xterm loaded the addon and once when it is released.
     */
    recordWebglContextAcquired(): void;
    recordWebglContextReleased(): void;
    /**
     * Reports one lost WebGL context so the `auto` preference can converge on DOM when losses repeat without a
     * Main-visible GPU process exit.
     */
    recordContextLoss(): void;
    /**
     * Clears the session incident budget only after an explicit user retry.
     */
    resetForManualRetry(): void;
}

/**
 * Probes the capability xterm actually needs instead of constructor presence, which remains truthy when Chromium cannot
 * create a WebGL2 context. The temporary context is released immediately so probing cannot evict a live Terminal
 * context from Chromium's per-page limit.
 */
export function isWebgl2Available(): boolean {
    try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2');
        if (!context) return false;
        try {
            return true;
        } finally {
            context.getExtension('WEBGL_lose_context')?.loseContext();
        }
    } catch {
        return false;
    }
}
