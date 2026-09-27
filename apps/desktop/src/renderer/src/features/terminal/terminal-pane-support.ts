import type { EditorNavigationTarget, TerminalFileLinkRefusalReason } from '@caxri/protocol';
import { errorMessage, isCaxriError } from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';
import type { ITheme, Terminal } from '@xterm/xterm';

import { openExternalUrl } from '../../lib/external-link';
import { sessionViewScope } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { revealEditorNavigation } from '../editor/editor-reveal';
import { openExternalEditorDocument } from '../editor/external-editor-documents';
import {
    dispatchExtensionViewAction,
    executeViewCatalogShortcut,
    invalidateControlledViewSnapshot,
} from '../view-containers/view-container-commands';
import {
    loadTerminalReferencePreview,
    openTerminalFileLink,
    registerTerminalInputGate,
    registerTerminalPasteHandler,
    resolveTerminalCommitLink,
    sendTerminalBinaryInput,
    sendTerminalInput,
    sendTerminalInputToAgent,
} from './terminal-commands';
import {
    openTerminalLinkCandidatePicker,
    registerTerminalLinkScanner,
} from './terminal-link-actions';
import { createTerminalLinkScanner } from './terminal-link-scanner';
import type { TerminalLinkContext, TerminalLinkMatch } from './terminal-links';
import { registerTerminalLinks } from './terminal-links';
import type { Osc52BlockReason } from './terminal-osc52-clipboard';
import { terminalPaneHost } from './terminal-pane-host';
import type { TerminalLinkReferenceContext } from './terminal-reference-links';
import {
    basicReferencePreviewCard,
    terminalReferencePreviewCard,
    terminalReferencePreviewRequest,
    TerminalReferencePreviewStore,
} from './terminal-reference-preview';
import type { TerminalSearchResults } from './terminal-search';

/**
 * Shared, non-hook support used by `useTerminalPaneRuntime`: user-facing copy, small pure helpers, and the xterm
 * registrations that wire a live Terminal to `terminal-commands.ts`. Kept in its own module so the hook file stays
 * under the repository's per-file line budget.
 */
export const onError = (message: string): void => pushToast('error', message);

/**
 * Closing or detaching a Terminal cancels its pending stream operations, sometimes before React tears down the pane.
 * That lifecycle signal needs no notification; actual transport and Server failures remain visible.
 */
export function reportTerminalOperationError(error: unknown, fallback: string): void {
    if (isCaxriError(error) && error.code === 'CANCELLED') return;
    onError(errorMessage(error, fallback));
}

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
 * Keeps keyboard input and Files-drop paste on the same live xterm path. `xterm.paste` preserves bracketed-paste
 * semantics. Xterm emits byte-encoded mouse reports through `onBinary`, separate from keyboard `onData`.
 */
export function registerTerminalInputHandlers(
    terminal: Terminal,
    terminalId: string,
    isRunning: () => boolean,
    expectedAgentLaunchId: () => string | undefined = () => {},
): () => void {
    let isDisposed = false;
    const sendInput = async (data: string): Promise<void> => {
        try {
            const expected = expectedAgentLaunchId();
            if (expected === undefined) await sendTerminalInput(terminalId, data);
            else await sendTerminalInputToAgent(terminalId, data, expected);
        } catch (error) {
            if (!isDisposed) reportTerminalOperationError(error, 'Terminal input failed');
        }
    };
    const dataDisposable = terminal.onData((data) => {
        if (!isRunning()) return;
        // xterm's onData callback cannot be async; sendInput already reports its own failure.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void sendInput(data);
    });
    const binaryDisposable = terminal.onBinary((data) => {
        if (!isRunning()) return;
        // eslint-disable-next-line no-void -- the request reports its own failure.
        void sendTerminalBinaryInput(terminalId, data, expectedAgentLaunchId()).catch((error) => {
            if (!isDisposed) reportTerminalOperationError(error, 'Terminal input failed');
        });
    });
    const unregisterInputGate = registerTerminalInputGate(terminalId, isRunning);
    const unregisterPasteHandler = registerTerminalPasteHandler(terminalId, {
        paste(data) {
            if (!isRunning()) return false;
            terminal.paste(data);
            terminal.focus();
            return true;
        },
    });
    return () => {
        isDisposed = true;
        unregisterInputGate();
        unregisterPasteHandler();
        dataDisposable.dispose();
        binaryDisposable.dispose();
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
 * What to say when Main refused a file link on its own. Without these the link reads as broken: the click lands, the
 * Terminal does nothing, and nothing anywhere says why. A user-initiated cancel carries no reason and stays silent.
 */
const TERMINAL_FILE_LINK_REFUSALS: Record<TerminalFileLinkRefusalReason, string> = {
    project_gone: 'That file\u{2019}s Project is no longer in Caxri.',
    worktree_project_unbound:
        'That file is in a Git worktree no Session is using as its Workbench Root. Continue a Session in the worktree first.',
};

const URL_LINKS_ONLY: ReadonlySet<TerminalLinkMatch['kind']> = new Set(['url']);

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
            const result = await openTerminalFileLink(latest().terminalId, target, location);
            if ('document' in result) {
                const workbenchProjectId = useWorkbenchStore
                    .getState()
                    .bootstrap?.sessions.find(
                        (session) => session.id === result.sessionId,
                    )?.workbenchProjectId;
                const opened =
                    workbenchProjectId !== undefined &&
                    openExternalEditorDocument({
                        document: result.document,
                        sessionId: result.sessionId,
                        workbenchProjectId,
                    });
                if (!opened) throw new Error('Unable to open external file in this Session');
                if (location)
                    revealEditorNavigation(
                        editorModelPath(
                            sessionViewScope(result.sessionId, workbenchProjectId),
                            opened,
                        ),
                        location,
                    );
                return;
            }
            if ('canceled' in result) {
                if (result.reason) onError(TERMINAL_FILE_LINK_REFUSALS[result.reason]);
                return;
            }
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
            const result = await resolveTerminalCommitLink(latest().terminalId, reference);
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
    const previews = new TerminalReferencePreviewStore(loadTerminalReferencePreview);
    const { hasWorkbenchLinks } = terminalPaneHost();
    const context: TerminalLinkContext = {
        ...(!hasWorkbenchLinks && { linkKinds: URL_LINKS_ONLY }),
        get referenceContext() {
            return latest().referenceContext;
        },
        previewReference(match) {
            const card = basicReferencePreviewCard(match);
            const request = hasWorkbenchLinks ? terminalReferencePreviewRequest(match) : undefined;
            if (!request) return { card };
            const { terminalId } = latest();
            return {
                card,
                load: async (signal) => {
                    const preview = await previews.load(terminalId, request, signal);
                    return preview && terminalReferencePreviewCard(match, preview);
                },
            };
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
            previews.clear();
            unregisterProvider();
            registration.dispose();
        },
        restoreOscLinks: (snapshots) => registration.restoreOscLinks(snapshots),
    };
}
