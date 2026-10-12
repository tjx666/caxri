import { isChatTerminal } from '@caxri/protocol';

import { getBootstrap } from '../../stores/selectors';
import type { TerminalCommandNavigationDirection } from './terminal-command-tracker';
import { didNavigateTerminalCommand } from './terminal-command-tracker';
import { openTerminalSearch } from './terminal-search';

/**
 * The mounted `TerminalPane` registers its clear handler here so `terminal.clear` can reach the live xterm instance
 * with a direct call instead of a window-wide `CustomEvent`. Only one pane owns a given Terminal at a time, so a plain
 * `Map` keyed by id is enough.
 */
const clearHandlers = new Map<string, () => void>();

export function registerTerminalClearHandler(terminalId: string, handler: () => void): () => void {
    clearHandlers.set(terminalId, handler);
    return () => {
        if (clearHandlers.get(terminalId) === handler) clearHandlers.delete(terminalId);
    };
}

export function clearActiveTerminal(terminalId: string): void {
    clearHandlers.get(terminalId)?.();
}

/**
 * Files-to-Terminal drops must enter through the mounted xterm instance so bracketed-paste mode, PTY ordering, and
 * focus behave exactly like an ordinary paste. The layout owns the drop target while the pane owns xterm, so this
 * per-Terminal registry bridges those two Renderer surfaces without adding another IPC input path.
 */
interface TerminalPasteHandlers {
    paste(data: string): boolean;
}

const pasteHandlers = new Map<string, TerminalPasteHandlers>();

export function registerTerminalPasteHandler(
    terminalId: string,
    handlers: TerminalPasteHandlers,
): () => void {
    pasteHandlers.set(terminalId, handlers);
    return () => {
        if (pasteHandlers.get(terminalId) === handlers) pasteHandlers.delete(terminalId);
    };
}

export function didPasteIntoTerminal(terminalId: string, data: string): boolean {
    return pasteHandlers.get(terminalId)?.paste(data) ?? false;
}

/**
 * Every Renderer input path consults the mounted pane's live gate so commands and dialogs cannot bypass a pending
 * long-paste lock. Missing gates preserve command behavior while a pane is still mounting.
 */
const inputGates = new Map<string, () => boolean>();

export function registerTerminalInputGate(
    terminalId: string,
    canAcceptInput: () => boolean,
): () => void {
    inputGates.set(terminalId, canAcceptInput);
    return () => {
        if (inputGates.get(terminalId) === canAcceptInput) inputGates.delete(terminalId);
    };
}

/**
 * A Chat Terminal has no PTY to write bytes into (ADR 0012), so every PTY input path refuses it here, at one boundary.
 */
export function canSendTerminalInput(terminalId: string): boolean {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    if (terminal && isChatTerminal(terminal)) return false;
    return inputGates.get(terminalId)?.() ?? true;
}

/**
 * Dialogs opened from a keyboard command have no DOM trigger for Base UI to restore focus to. The mounted Terminal pane
 * therefore exposes its live xterm focus operation through the same ownership-safe registry used by clear and copy. The
 * element getter serves the picker close path, where Base UI wants the target element itself rather than an imperative
 * focus call (see `lib/picker-final-focus.ts`).
 */
interface TerminalFocusHandler {
    focus: () => void;
    getFocusElement: () => HTMLElement | null;
}

const focusHandlers = new Map<string, TerminalFocusHandler>();

export function registerTerminalFocusHandler(
    terminalId: string,
    focus: () => void,
    getFocusElement: () => HTMLElement | null = () => null,
): () => void {
    const handler: TerminalFocusHandler = { focus, getFocusElement };
    focusHandlers.set(terminalId, handler);
    return () => {
        if (focusHandlers.get(terminalId) === handler) focusHandlers.delete(terminalId);
    };
}

export function focusTerminalById(terminalId: string): void {
    focusHandlers.get(terminalId)?.focus();
}

export function getTerminalFocusElement(terminalId: string): HTMLElement | null {
    return focusHandlers.get(terminalId)?.getFocusElement() ?? null;
}

/**
 * Server admits ordinary `terminal.input` only while a Renderer view holds the Terminal's attachment (`acceptInput` in
 * the Terminal Host drops it silently otherwise). A hidden tab has no mounted pane and therefore no attachment, so a
 * command that first reveals a Terminal must wait here before writing into it. The mounted pane reports the initial
 * attach completion; unmounting clears it.
 */
const attachedTerminals = new Set<string>();
const attachmentWaiters = new Map<string, Set<() => void>>();

export function markTerminalAttached(terminalId: string, isAttached: boolean): void {
    if (!isAttached) {
        attachedTerminals.delete(terminalId);
        return;
    }
    attachedTerminals.add(terminalId);
    const waiters = attachmentWaiters.get(terminalId);
    attachmentWaiters.delete(terminalId);
    if (waiters) for (const resolve of waiters) resolve();
}

export function isTerminalAttached(terminalId: string): boolean {
    return attachedTerminals.has(terminalId);
}

/**
 * Resolves `true` once the Terminal's pane has attached, or `false` after `timeoutMs` without an attachment.
 */
export function whenTerminalAttached(terminalId: string, timeoutMs: number): Promise<boolean> {
    if (attachedTerminals.has(terminalId)) return Promise.resolve(true);
    return new Promise((resolve) => {
        const waiters = attachmentWaiters.get(terminalId) ?? new Set();
        attachmentWaiters.set(terminalId, waiters);
        const timer = setTimeout(() => {
            waiters.delete(settle);
            if (waiters.size === 0 && attachmentWaiters.get(terminalId) === waiters)
                attachmentWaiters.delete(terminalId);
            resolve(false);
        }, timeoutMs);
        function settle(): void {
            clearTimeout(timer);
            resolve(true);
        }
        waiters.add(settle);
    });
}

/**
 * The mounted `TerminalPane` registers its live xterm selection here, mirroring {@link registerTerminalClearHandler}:
 * `copySelection` reuses `TerminalSelectionClipboard` (already serializing writes against a stale selection) instead of
 * a second clipboard write path, and `hasSelection` backs both the `terminal.copy` command's `when` gate and the
 * context menu's disabled state.
 */
interface TerminalSelectionHandlers {
    copySelection(): void;
    hasSelection(): boolean;
}

const selectionHandlers = new Map<string, TerminalSelectionHandlers>();

export function registerTerminalSelectionHandlers(
    terminalId: string,
    handlers: TerminalSelectionHandlers,
): () => void {
    selectionHandlers.set(terminalId, handlers);
    return () => {
        if (selectionHandlers.get(terminalId) === handlers) selectionHandlers.delete(terminalId);
    };
}

export function copyActiveTerminalSelection(terminalId: string): void {
    selectionHandlers.get(terminalId)?.copySelection();
}

/**
 * Answers only "does this Terminal currently own a selection": focus is checked by the caller.
 */
export function hasActiveTerminalSelection(terminalId: string): boolean {
    return selectionHandlers.get(terminalId)?.hasSelection() ?? false;
}

export function findInActiveTerminal(terminalId: string): void {
    openTerminalSearch(terminalId);
}

export function navigateActiveTerminalCommand(
    terminalId: string,
    direction: TerminalCommandNavigationDirection,
): void {
    didNavigateTerminalCommand(terminalId, direction);
}
