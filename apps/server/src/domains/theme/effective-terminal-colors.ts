import type { AppSettings, SystemColorScheme, ThemeTokens } from '@caxri/protocol';
import { resolveEffectiveTheme } from '@caxri/protocol';
import { notifyListenersThenRethrow } from '@caxri/utils';

/**
 * The background and foreground the Terminal Host answers OSC 10/11 queries with: the terminal colors of the same
 * effective theme the Renderer paints (`resolveEffectiveTheme`), so a TUI picks the light or dark palette that matches
 * the window it runs in.
 */
function effectiveTerminalColors(
    theme: ThemeTokens,
    settings: Pick<
        AppSettings,
        'workbench.theme.dark' | 'workbench.theme.followSystem' | 'workbench.theme.light'
    >,
    scheme: SystemColorScheme,
): { background: string; foreground: string } {
    const { background, foreground } = resolveEffectiveTheme(theme, settings, scheme).terminal;
    return { background, foreground };
}

interface SystemAppearanceConfig {
    getSettings(): { value: AppSettings };
    getTheme(): { value: ThemeTokens };
    subscribeSettings(listener: () => void): () => void;
}

/**
 * Server Core has no display, so it cannot observe the system appearance: Desktop Main reports it (on connect and on
 * every change) and this class resolves the effective terminal colors from it. Until a Desktop reports one, the dark
 * default keeps the pre-existing Dracula answers.
 */
export class SystemAppearance {
    private current: SystemColorScheme = 'dark';
    private readonly listeners = new Set<() => void>();
    readonly terminalColors = (): { background: string; foreground: string } =>
        effectiveTerminalColors(
            this.config.getTheme().value,
            this.config.getSettings().value,
            this.current,
        );

    constructor(private readonly config: SystemAppearanceConfig) {}

    set(scheme: SystemColorScheme): void {
        if (scheme === this.current) return;
        this.current = scheme;
        notifyListenersThenRethrow(this.listeners, undefined);
    }

    /**
     * Calls `listener` whenever the effective terminal colors may have changed: a different reported appearance, or a
     * settings change (theme pairing or "Follow system appearance"). Returns the unsubscribe.
     */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        const unsubscribeSettings = this.config.subscribeSettings(listener);
        return () => {
            this.listeners.delete(listener);
            unsubscribeSettings();
        };
    }
}
