import type {
    GitCommitDetails,
    GitCommitPage,
    SourceControlHistoryDetails,
    SourceControlHistoryPage,
} from 'caxri';

import { gitHubAvatarUrl, shouldFetchGitHubAvatar } from './github-avatar';
import type { RegisterSourceControlAction } from './source-control-model';
import {
    boundedActionLabel,
    boundedEditorResource,
    boundedResourceTooltip,
    sourceControlResourceProjection,
} from './source-control-projection';
import { boundedSourceControlResourceId } from './source-control-resource-id';

export function buildSourceControlHistoryPage(
    page: GitCommitPage,
    revision: string,
    remoteHost?: string | null,
): SourceControlHistoryPage {
    return {
        revision,
        items: page.commits.map((commit) => {
            const avatarUrl = shouldFetchGitHubAvatar(remoteHost, true)
                ? gitHubAvatarUrl(commit.authorEmail, 60)
                : undefined;
            return {
                id: commit.sha,
                label: commit.subject || '(no subject)',
                description: commit.shortSha,
                timestamp: commit.authoredAt,
                tooltipTimestamp: new Date(commit.authoredAt).toLocaleString(),
                author: commit.author,
                authorFallback: commit.author.trim().slice(0, 1) || '?',
                ...(avatarUrl && { avatarUrl }),
                decorations: commit.decorations,
                ...(commit.body && { body: commit.body }),
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
    registerAction: RegisterSourceControlAction;
    repositoryId: string;
    revision: string;
}): SourceControlHistoryDetails {
    const { details, registerAction, repositoryId, revision } = options;
    return {
        revision,
        itemId: details.commit.sha,
        summary: `${details.files.length} file${details.files.length === 1 ? '' : 's'} changed${details.filesTruncated ? '+' : ''}`,
        additions: details.additions,
        deletions: details.deletions,
        resources: details.files.map((file) => {
            const rawResource = `caxri-git-diff://commit-file/${encodeURIComponent(repositoryId)}/${details.commit.sha}/${encodeURIComponent(file.path)}`;
            const resource = boundedEditorResource(rawResource);
            const projection = sourceControlResourceProjection(file.path);
            const action = resource
                ? registerAction({
                      command: { id: 'caxri.git.openChanges', arguments: [resource] },
                      icon: { kind: 'theme', id: 'diff' },
                      label: boundedActionLabel(`Open changes in ${file.path}`),
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
                ...(resource && { editorResource: resource, action }),
            };
        }),
        truncated: details.filesTruncated,
    };
}
