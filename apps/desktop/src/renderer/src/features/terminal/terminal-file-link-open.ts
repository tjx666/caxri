import type {
    EditorNavigationTarget,
    MethodResult,
    TerminalFileLinkRefusalReason,
} from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { sessionViewScope } from '../../stores/session-view';
import { describeFailure, pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { revealEditorNavigation } from '../editor/editor-reveal';
import { openExternalEditorDocument } from '../editor/external-editor-documents';
import { openTerminalLinkCandidatePicker } from './terminal-link-actions';
import { openBotFileLink, openTerminalFileLink } from './terminal-link-commands';

/**
 * What to say when Main refused a file link on its own. Without these the link reads as broken: the click lands, the
 * Terminal does nothing, and nothing anywhere says why. A user-initiated cancel carries no reason and stays silent.
 */
const TERMINAL_FILE_LINK_REFUSALS: Record<TerminalFileLinkRefusalReason, TranslationKey> = {
    outside_projects: 'terminal.links.refusal.outsideProjects',
    project_gone: 'terminal.links.refusal.projectGone',
    worktree_project_unbound: 'terminal.links.refusal.worktreeProjectUnbound',
};

const onError = (message: string): void => pushToast('error', message);

/**
 * Opens a file path a Terminal printed, or an Agent Chat reply cited, resolved against the Projects that Terminal may
 * reach. One opened document is revealed at `location`; several matching Projects open the Terminal's candidate picker
 * (mounted by its pane); a refusal or failure is reported as a toast. Never rejects.
 */
export async function openTerminalFileTarget(
    terminalId: string,
    target: string,
    location: EditorNavigationTarget | undefined,
    { hasWorkbenchLinks }: { hasWorkbenchLinks: boolean },
): Promise<void> {
    try {
        /**
         * The Caxri Bot Terminal has no editor of its own, so its opener hands the link to the Workbench through a
         * separate, Main-validated request instead of `terminal.openFileLink` (see `hasWorkbenchLinks`'s JSDoc).
         *
         * Deliberately an `if`/`else` assigning into an explicitly typed `result`, not a ternary: both calls return the
         * same shared result union (`terminalFileLinkOpenResultSchema`), but a ternary combining two independently
         * named aliases of that identical union makes TypeScript compute their "best common type" across branches
         * instead of keeping the declared union, and it collapses the subtype `{ opened: true; document; sessionId }`
         * into the plain `{ opened: true }` member it structurally overlaps with, silently losing
         * `document`/`sessionId` from the inferred type. Assigning into a pre-typed variable checks each branch against
         * that type independently and keeps every member intact.
         */
        let result: MethodResult<'terminal.openFileLink'>;
        if (hasWorkbenchLinks) {
            result = await openTerminalFileLink(terminalId, target, location);
        } else {
            result = await openBotFileLink(terminalId, target, location);
        }
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
            if (!opened) throw new Error(translate('terminal.links.openExternalFileFailed'));
            if (location)
                revealEditorNavigation(
                    editorModelPath(sessionViewScope(result.sessionId, workbenchProjectId), opened),
                    location,
                );
            return;
        }
        if ('canceled' in result) {
            if (result.reason) onError(translate(TERMINAL_FILE_LINK_REFUSALS[result.reason]));
            return;
        }
        if ('status' in result)
            openTerminalLinkCandidatePicker(
                terminalId,
                result.candidates.map((candidate) => ({
                    accessibleName: translate('terminal.links.matchingFile.accessibleName', {
                        path: candidate.relativePath,
                        project: candidate.projectTitle,
                    }),
                    activate: () => {
                        void openTerminalFileTarget(terminalId, candidate.path, location, {
                            hasWorkbenchLinks,
                        });
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
        onError(describeFailure(error, translate('terminal.links.fileLinkFailed')));
    }
}
