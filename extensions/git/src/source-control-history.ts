import type {
    GitCommitDetails,
    GitCommitPage,
    SourceControlHistoryDetails,
    SourceControlHistoryPage,
} from 'caxri';
import { isGlobMatch, l10n } from 'caxri';

import { gitHubAvatarUrl, shouldFetchGitHubAvatar } from './github-avatar';
import type { RegisterSourceControlAction } from './source-control-model';
import {
    boundedActionLabel,
    boundedEditorResource,
    boundedResourceTooltip,
    sourceControlLineStats,
    sourceControlResourceProjection,
} from './source-control-projection';
import { boundedSourceControlResourceId } from './source-control-resource-id';

/**
 * Present only for path-scoped history. Repository history remains passive so its rows can continue expanding commit
 * details, while File History opens the exact committed file through a revision-bound provider action.
 */
interface FileHistoryActionOptions {
    path: string;
    registerAction: RegisterSourceControlAction;
    repositoryId: string;
}

/**
 * The details header (`3 files changed+ · 1 hidden`); `+` marks a file list the Server truncated.
 */
function historySummary(fileCount: number, isTruncated: boolean, hiddenCount: number): string {
    const changed =
        fileCount === 1
            ? l10n.t('{count} file changed', { count: fileCount })
            : l10n.t('{count} files changed', { count: fileCount });
    const hidden = hiddenCount > 0 ? ` · ${l10n.t('{count} hidden', { count: hiddenCount })}` : '';
    return `${changed}${isTruncated ? '+' : ''}${hidden}`;
}

export function buildSourceControlHistoryPage(
    page: GitCommitPage,
    revision: string,
    remoteHost?: string | null,
    fileHistoryAction?: FileHistoryActionOptions,
): SourceControlHistoryPage {
    return {
        revision,
        items: page.commits.map((commit) => {
            const avatarUrl = shouldFetchGitHubAvatar(remoteHost, true)
                ? gitHubAvatarUrl(commit.authorEmail, 60)
                : undefined;
            const rawResource = fileHistoryAction
                ? `caxri-git-diff://commit-file/${encodeURIComponent(fileHistoryAction.repositoryId)}/${commit.sha}/${encodeURIComponent(fileHistoryAction.path)}`
                : undefined;
            const resource = rawResource ? boundedEditorResource(rawResource) : undefined;
            return {
                id: commit.sha,
                label: commit.subject || l10n.t('(no subject)'),
                description: commit.shortSha,
                timestamp: commit.authoredAt,
                tooltipTimestamp: new Date(commit.authoredAt).toLocaleString(),
                author: commit.author,
                authorFallback: commit.author.trim().slice(0, 1) || '?',
                ...(avatarUrl && { avatarUrl }),
                decorations: commit.decorations,
                ...(commit.body && { body: commit.body }),
                ...(resource &&
                    fileHistoryAction && {
                        action: fileHistoryAction.registerAction({
                            command: { id: 'caxri.git.openChanges', arguments: [resource] },
                            icon: { kind: 'theme', id: 'diff' },
                            label: boundedActionLabel(
                                l10n.t('Open changes in {path}', { path: fileHistoryAction.path }),
                            ),
                        }),
                    }),
            };
        }),
        ...(page.nextOffset !== undefined && { nextOffset: page.nextOffset }),
    };
}

const detailStatus = {
    'modified': { identifier: 'modified', label: 'M', tone: 'warning' },
    'added': { identifier: 'added', label: 'A', tone: 'success' },
    'deleted': { identifier: 'deleted', label: 'D', tone: 'danger' },
    'renamed': { identifier: 'renamed', label: 'R', tone: 'warning' },
    'copied': { identifier: 'added', label: 'C', tone: 'success' },
    'type-changed': { identifier: 'modified', label: 'T', tone: 'warning' },
    'unknown': { identifier: 'modified', label: '?', tone: 'warning' },
} as const;

export function buildSourceControlHistoryDetails(options: {
    details: GitCommitDetails;
    excludePatterns?: Readonly<Record<string, boolean>>;
    registerAction: RegisterSourceControlAction;
    repositoryId: string;
    revision: string;
    isShowingExcluded?: boolean;
}): SourceControlHistoryDetails {
    const {
        details,
        excludePatterns = {},
        registerAction,
        repositoryId,
        revision,
        isShowingExcluded = false,
    } = options;
    const excludedCount = details.files.filter((file) =>
        isGlobMatch(file.path, excludePatterns),
    ).length;
    const files = isShowingExcluded
        ? details.files
        : details.files.filter((file) => !isGlobMatch(file.path, excludePatterns));
    return {
        revision,
        itemId: details.commit.sha,
        summary: historySummary(
            details.files.length,
            details.filesTruncated,
            isShowingExcluded ? 0 : excludedCount,
        ),
        additions: details.additions,
        deletions: details.deletions,
        ...(!isShowingExcluded && excludedCount > 0 && { hiddenCount: excludedCount }),
        resources: files.map((file) => {
            const rawResource = `caxri-git-diff://commit-file/${encodeURIComponent(repositoryId)}/${details.commit.sha}/${encodeURIComponent(file.path)}`;
            const resource = boundedEditorResource(rawResource);
            const projection = sourceControlResourceProjection(file.path);
            const action = resource
                ? registerAction({
                      command: { id: 'caxri.git.openChanges', arguments: [resource] },
                      icon: { kind: 'theme', id: 'diff' },
                      label: boundedActionLabel(
                          l10n.t('Open changes in {path}', { path: file.path }),
                      ),
                  })
                : undefined;
            return {
                id: boundedSourceControlResourceId(repositoryId, details.commit.sha, file.path),
                label: projection.label,
                description: file.status,
                tooltip: file.previousPath
                    ? boundedResourceTooltip(`${file.previousPath} → ${file.path}`)
                    : projection.tooltip,
                accessibilityLabel: projection.accessibilityLabel,
                icon: { kind: 'file-type' as const, name: projection.label },
                path: projection.path,
                decoration: detailStatus[file.status],
                ...sourceControlLineStats(file),
                ...(resource && { editorResource: resource, action }),
            };
        }),
        truncated: details.filesTruncated,
    };
}
