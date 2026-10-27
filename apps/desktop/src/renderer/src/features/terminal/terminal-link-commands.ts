import type {
    EditorNavigationTarget,
    MethodResult,
    TerminalReferencePreviewRequest,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * Resolves a path printed in the Terminal against the Projects this Terminal may reach. The result is either the opened
 * document, or the candidates to disambiguate when more than one Project matched.
 */
export async function openTerminalFileLink(
    terminalId: string,
    target: string,
    location?: EditorNavigationTarget,
): Promise<MethodResult<'terminal.openFileLink'>> {
    return caxri.request('terminal.openFileLink', {
        terminalId,
        target,
        ...(location && { location }),
    });
}

/**
 * Caxri Bot's counterpart to {@link openTerminalFileLink}: same resolution, but Main hands the opened file to a real,
 * visible Session instead of Caxri Bot's own hidden one. Only the Caxri Bot Terminal pane calls this (see
 * `hasWorkbenchLinks` in `terminal-pane-host.ts`); Main independently validates that `terminalId` names Caxri Bot's own
 * Terminal.
 */
export async function openBotFileLink(
    terminalId: string,
    target: string,
    location?: EditorNavigationTarget,
): Promise<MethodResult<'caxriBot.openFileLink'>> {
    return caxri.request('caxriBot.openFileLink', {
        terminalId,
        target,
        ...(location && { location }),
    });
}

/**
 * Resolves a commit reference printed in the Terminal to a repository and SHA, or to the repositories that all contain
 * that reference.
 */
export async function resolveTerminalCommitLink(
    terminalId: string,
    reference: string,
): Promise<MethodResult<'terminal.commitLink.resolve'>> {
    return caxri.request('terminal.commitLink.resolve', { terminalId, reference });
}

/**
 * Reads the metadata behind one hovered reference. Carries a signal because the caller is a hover card: the pointer
 * moving on is the common case, and the read it started must stop with it rather than finish into nothing.
 */
export function loadTerminalReferencePreview(
    terminalId: string,
    reference: TerminalReferencePreviewRequest,
    signal: AbortSignal,
): Promise<MethodResult<'terminal.reference.preview'>> {
    return caxri.requestWithSignal('terminal.reference.preview', signal, { terminalId, reference });
}
