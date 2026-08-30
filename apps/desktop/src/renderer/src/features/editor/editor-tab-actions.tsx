import { gitCommitFileDiffTabPath, gitPullRequestFileDiffTabPath } from '@caxri/protocol';
import { GitCommitHorizontal, GitPullRequest } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession } from '../../stores/selectors';
import { openEditorTab } from './document-actions';

/**
 * Fixed actions for the active ordinary file. The optional `git.fileHead` annotation already resolves the innermost
 * authorized repository, so the Renderer never guesses repository ownership from path prefixes.
 */
export function EditorTabActions({ path }: { path: string }) {
    const session = useSelectedSession();
    const head = useCaxriQuery(
        'git.fileHead',
        { sessionId: session?.id ?? '', path },
        { enabled: Boolean(session), retry: false, staleTime: 60_000 },
    ).data;
    if (!head) return null;
    return (
        <>
            <Tooltip content="Open Last Commit Changes">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Open Last Commit Changes"
                    onClick={() =>
                        openEditorTab(
                            gitCommitFileDiffTabPath(head.repositoryId, head.sha, head.path),
                        )
                    }
                >
                    <GitCommitHorizontal aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
            <Tooltip content="Open Pull Request Changes">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Open Pull Request Changes"
                    onClick={() =>
                        openEditorTab(gitPullRequestFileDiffTabPath(head.repositoryId, head.path))
                    }
                >
                    <GitPullRequest aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
        </>
    );
}
