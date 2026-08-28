import type { EditorNavigationTarget } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { ITheme, Terminal } from '@xterm/xterm';

import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import {
    dispatchExtensionViewAction,
    executeViewCatalogShortcut,
    invalidateControlledViewSnapshot,
} from '../view-containers/view-container-commands';
import { registerTerminalPasteHandler } from './terminal-actions';
import {
    openTerminalLinkCandidatePicker,
    registerTerminalLinkScanner,
} from './terminal-link-actions';
import { createTerminalLinkScanner } from './terminal-link-scanner';
import type { TerminalLinkContext } from './terminal-links';
import { registerTerminalLinks } from './terminal-links';
import type { Osc52BlockReason } from './terminal-osc52-clipboard';
import type { TerminalLinkReferenceContext } from './terminal-reference-links';
import type { TerminalSearchResults } from './terminal-search';

/**
 * Shared, non-hook support used by `useTerminalPaneRuntime`: user-facing copy, small pure helpers, and the one Server
 * call whose failure is intentionally unobserved. Kept in its own module so the hook file stays under the repository's
 * per-file line budget.
 */
export const onError = (message: string): void => pushToast('error', message);

/**
 * A blocked OSC 52 write is expected policy enforcement, not a failure — it uses `info` (which auto-dismisses) rather
 * than the persistent `error` styling reserved for `onWriteFailure` below.
 */
export const OSC52_BLOCK_MESSAGES: Record<Osc52BlockReason, string> = {
    'disabled':
        'A Terminal program tried to copy to the clipboard, but OSC 52 access is off in Settings.',
    'malformed': 'A Terminal program sent a malformed clipboard request; it was ignored.',
    'oversized': 'A Terminal program tried to copy too much text at once; the request was ignored.',
    'rate-limited':
        'A Terminal program is copying to the clipboard too quickly; extra requests are being ignored.',
};

export const emptySearchResults: TerminalSearchResults = { resultCount: 0, resultIndex: -1 };

/**
 * SearchAddon requires opaque `#RRGGBB`; imported semantic tokens may include an alpha byte.
 */
export function opaqueSearchColor(color: string): string {
    return color.slice(0, 7);
}

/**
 * Xterm creates an overview-ruler canvas whenever the custom scrollbar has a width and paints its left border with the
 * Terminal foreground color even when no overview markers exist. Caxri uses that ruler for transient search markers,
 * not persistent decorations, so preserve the markers while hiding the otherwise permanent white hairline.
 */
export function xtermThemeWithoutOverviewRulerBorder(theme: ITheme | undefined): ITheme {
    return { ...theme, overviewRulerBorder: 'transparent' };
}

/**
 * A Server restart can race a pane teardown, leaving no live view to notify; the failure is intentionally unobserved
 * instead of surfaced through `onError`.
 */
export async function detachTerminalQuietly(terminalId: string): Promise<void> {
    try {
        await caxri.request('terminal.detach', { terminalId });
    } catch {
        // Intentionally swallowed, see the function comment above.
    }
}

/**
 * Keeps keyboard input and Files-drop paste on the same live xterm path. `xterm.paste` preserves bracketed-paste
 * semantics, while `onData` remains the single ordered bridge into the Server-owned PTY.
 */
export function registerTerminalInputHandlers(
    terminal: Terminal,
    terminalId: string,
    isRunning: () => boolean,
): () => void {
    const sendInput = async (data: string): Promise<void> => {
        try {
            await caxri.request('terminal.input', { terminalId, data });
        } catch (error) {
            onError(errorMessage(error, 'Terminal input failed'));
        }
    };
    const dataDisposable = terminal.onData((data) => {
        if (!isRunning()) return;
        // xterm's onData callback cannot be async; sendInput already reports its own failure.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void sendInput(data);
    });
    const unregisterPasteHandler = registerTerminalPasteHandler(terminalId, {
        paste(data) {
            if (!isRunning()) return false;
            terminal.paste(data);
            terminal.focus();
            return true;
        },
    });
    return () => {
        unregisterPasteHandler();
        dataDisposable.dispose();
    };
}

interface TerminalLinkSnapshot {
    referenceContext: TerminalLinkReferenceContext;
    terminalId: string;
    wordSeparators: string;
}

interface TerminalPaneLinkRegistration {
    dispose(): void;
    restoreOscLinks: ReturnType<typeof registerTerminalLinks>['restoreOscLinks'];
}

/**
 * Wires `registerTerminalLinks` to the pane's live state snapshot: link providers are registered once per attach, so
 * every field reads through `latest()` instead of capturing values that would go stale on session or settings changes.
 */
export function registerTerminalPaneLinks(
    terminal: Terminal,
    latest: () => TerminalLinkSnapshot,
): TerminalPaneLinkRegistration {
    const openFileLink = async (
        target: string,
        location: EditorNavigationTarget | undefined,
    ): Promise<void> => {
        try {
            const result = await caxri.request('terminal.openFileLink', {
                terminalId: latest().terminalId,
                target,
                ...(location && { location }),
            });
            if ('status' in result)
                openTerminalLinkCandidatePicker(
                    latest().terminalId,
                    result.candidates.map((candidate) => ({
                        accessibleName: `Open matching file ${candidate.relativePath} in ${candidate.projectTitle}`,
                        activate: () => {
                            // eslint-disable-next-line no-void -- this helper owns user-visible failure reporting
                            void openFileLink(candidate.path, location);
                        },
                        bufferLine: 0,
                        detail: candidate.projectTitle,
                        id: `candidate:${candidate.projectId}:${candidate.path}`,
                        kind: 'file',
                        target: candidate.relativePath,
                    })),
                    result.truncated,
                );
        } catch (error) {
            onError(errorMessage(error, 'Terminal file link failed'));
        }
    };
    const openCommitCandidate = async (repoId: string, sha: string): Promise<void> => {
        await executeViewCatalogShortcut('secondarySidebar.showGit');
        const status = await dispatchExtensionViewAction(
            'caxri.git.openCommit',
            'Open Git Commit',
            [repoId, sha],
        );
        if (status === 'executed')
            await invalidateControlledViewSnapshot('caxri.git.sourceControl');
    };
    const openCommitLink = async (reference: string): Promise<void> => {
        try {
            const result = await caxri.request('terminal.commitLink.resolve', {
                terminalId: latest().terminalId,
                reference,
            });
            if (result.status === 'resolved') {
                await openCommitCandidate(result.candidate.repositoryId, result.candidate.sha);
                return;
            }
            openTerminalLinkCandidatePicker(
                latest().terminalId,
                result.candidates.map((candidate) => ({
                    accessibleName: `Show commit ${reference} in ${candidate.repositoryName}`,
                    activate: () => {
                        // eslint-disable-next-line no-void -- this helper owns user-visible failure reporting
                        void openCommitCandidate(candidate.repositoryId, candidate.sha);
                    },
                    bufferLine: 0,
                    detail: candidate.repositoryName,
                    id: `commit:${candidate.repositoryId}:${candidate.sha}`,
                    kind: 'commit',
                    target: candidate.sha,
                })),
                false,
            );
        } catch (error) {
            onError(errorMessage(error, 'Git commit link failed'));
        }
    };
    const context: TerminalLinkContext = {
        get referenceContext() {
            return latest().referenceContext;
        },
        get wordSeparators() {
            return latest().wordSeparators;
        },
        async openCommit(reference) {
            await openCommitLink(reference);
        },
        async openFile(target, location) {
            await openFileLink(target, location);
        },
        async openUrl(url) {
            await openExternalUrl(url, onError);
        },
    };
    const registration = registerTerminalLinks(terminal, context);
    const unregisterProvider = registerTerminalLinkScanner(latest().terminalId, () =>
        createTerminalLinkScanner(terminal, context, registration.getAllOscLinks()),
    );
    return {
        dispose() {
            unregisterProvider();
            registration.dispose();
        },
        restoreOscLinks: (snapshots) => registration.restoreOscLinks(snapshots),
    };
}
