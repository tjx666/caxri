import type { TerminalLinkScanner } from './terminal-link-scanner';
import type { TerminalDetectedLink } from './terminal-links';

type TerminalLinkScannerFactory = () => TerminalLinkScanner;

interface TerminalLinkPickerHandler {
    openCandidates(links: TerminalDetectedLink[], isTruncated: boolean): void;
    openDetected(): void;
}

const linkScannerFactories = new Map<string, TerminalLinkScannerFactory>();
const pickerHandlers = new Map<string, TerminalLinkPickerHandler>();

/**
 * Bridges the pane-owned xterm buffer to the pane-owned React picker without copying Terminal content into a global
 * store. The factory is invoked only when the user opens the picker and returns a fresh, single-use scanner over a
 * transient viewport + scrollback snapshot (`terminal-link-scanner.ts`).
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
    handler: TerminalLinkPickerHandler,
): () => void {
    pickerHandlers.set(terminalId, handler);
    return () => {
        if (pickerHandlers.get(terminalId) === handler) pickerHandlers.delete(terminalId);
    };
}

export function openTerminalLinkPicker(terminalId: string): void {
    pickerHandlers.get(terminalId)?.openDetected();
}

export function openTerminalFileCandidatePicker(
    terminalId: string,
    links: TerminalDetectedLink[],
    isTruncated: boolean,
): void {
    pickerHandlers.get(terminalId)?.openCandidates(links, isTruncated);
}
