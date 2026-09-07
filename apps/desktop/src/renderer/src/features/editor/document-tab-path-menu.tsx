import { parseGitDiffTab } from '@caxri/protocol';

import { ContextMenuItem } from '../../components/ui/context-menu';
import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { copyDocumentTabPath, resolveDocumentTabPath } from './document-tab-path-actions';

function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard; the action reports its own errors via toast
    void promise;
}

/**
 * Adds path actions to a document tab's pane menu. Virtual resources without one filesystem file return no entries;
 * `git.overview` supplies authorized roots so nested repositories and submodules use their own relative path.
 */
export function DocumentTabPathMenu({ path }: { path: string }) {
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
    const overviewQuery = useCaxriQuery(
        'git.overview',
        { sessionId: session?.id ?? '' },
        { enabled: Boolean(session), staleTime: 60_000 },
    );
    const overview = overviewQuery.data;
    const resolution = resolveDocumentTabPath(path, {
        projectRoot: project?.rootPath,
        repositories: overview?.repositories,
    });
    const diffTab = parseGitDiffTab(path);
    const isSingleFileDiff = diffTab?.kind === 'file' || diffTab?.kind === 'commit-file';
    if (!resolution && !isSingleFileDiff) return null;
    const unavailableReason = overviewQuery.isError
        ? 'Unable to load repository information'
        : overviewQuery.isPending
          ? 'Repository information is still loading'
          : 'The repository path is unavailable';
    return (
        <>
            <ContextMenuItem
                disabled={!resolution}
                disabledReason={!resolution ? unavailableReason : undefined}
                onClick={() => {
                    if (resolution) discard(copyDocumentTabPath(resolution.absolutePath));
                }}
            >
                Copy Path
            </ContextMenuItem>
            <ContextMenuItem
                disabled={!resolution?.relativeRoot}
                disabledReason={!resolution?.relativeRoot ? unavailableReason : undefined}
                onClick={() => {
                    if (resolution?.relativeRoot)
                        discard(
                            copyDocumentTabPath(resolution.absolutePath, resolution.relativeRoot),
                        );
                }}
            >
                Copy Relative Path
            </ContextMenuItem>
        </>
    );
}
