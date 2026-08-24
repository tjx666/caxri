import type { TerminalLinkScanner } from './terminal-links';

type TerminalLinkScannerFactory = () => TerminalLinkScanner;

const linkScannerFactories = new Map<string, TerminalLinkScannerFactory>();
const pickerHandlers = new Map<string, () => void>();

/**
 * Bridges the pane-owned xterm buffer to the pane-owned React picker without copying Terminal content into a global
 * store. The factory is invoked only when the user opens the picker and returns a fresh, single-use scanner over a
 * transient viewport + scrollback snapshot (`terminal-links.ts`'s `createTerminalLinkScanner`).
 */
export function registerTerminalLinkScanner(
    terminalId: string,
    factory: TerminalLinkScannerFactory,
): () => void {
    linkScannerFactories.set(terminalId, factory);
    return () => {
        if (linkScannerFactories.get(terminalId) === factory)
            linkScannerFactories.delete(terminalId);
    };
}

export function createTerminalLinkScanner(terminalId: string): TerminalLinkScanner | undefined {
    return linkScannerFactories.get(terminalId)?.();
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
