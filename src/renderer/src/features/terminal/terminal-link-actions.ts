import type { TerminalDetectedLink } from './terminal-links';

type TerminalLinkProvider = () => TerminalDetectedLink[];

const linkProviders = new Map<string, TerminalLinkProvider>();
const pickerHandlers = new Map<string, () => void>();

/**
 * Bridges the pane-owned xterm buffer to the pane-owned React picker without copying Terminal content into a global
 * store. The provider is invoked only when the user opens the command and returns a transient viewport snapshot.
 */
export function registerTerminalLinkProvider(
    terminalId: string,
    provider: TerminalLinkProvider,
): () => void {
    linkProviders.set(terminalId, provider);
    return () => {
        if (linkProviders.get(terminalId) === provider) linkProviders.delete(terminalId);
    };
}

export function getTerminalDetectedLinks(terminalId: string): TerminalDetectedLink[] {
    return linkProviders.get(terminalId)?.() ?? [];
}

/**
 * Command execution and the picker live on opposite sides of the declarative/imperative Terminal boundary. This
 * per-Terminal callback mirrors the existing clear/search registries and adds no IPC or external authority.
 */
export function registerTerminalLinkPickerHandler(
    terminalId: string,
    handler: () => void,
): () => void {
    pickerHandlers.set(terminalId, handler);
    return () => {
        if (pickerHandlers.get(terminalId) === handler) pickerHandlers.delete(terminalId);
    };
}

export function openTerminalLinkPicker(terminalId: string): void {
    pickerHandlers.get(terminalId)?.();
}
