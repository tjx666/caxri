import type { SourceControlViewModel } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    Eye,
    EyeOff,
    FileDiff,
    FileText,
    FolderTree,
    GitCommitHorizontal,
    GitPullRequest,
    Package,
    RefreshCw,
} from 'lucide-react';

import { ArchiveIcon } from '../../../icons/codicons/archive-icon';
import { DiffMultipleIcon } from '../../../icons/codicons/diff-multiple-icon';
import { DiscardIcon } from '../../../icons/codicons/discard-icon';
import { RepoIcon } from '../../../icons/codicons/repo-icon';
import { SyncIcon } from '../../../icons/codicons/sync-icon';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';

type ModelIcon = SourceControlViewModel['refreshAction']['icon'];

const icons: Readonly<Record<string, LucideIcon>> = {
    'eye': Eye,
    'eye-off': EyeOff,
    'diff': FileDiff,
    'file': FileText,
    'git-commit': GitCommitHorizontal,
    'git-pull-request': GitPullRequest,
    'refresh': RefreshCw,
    'worktree': FolderTree,
};

/**
 * Renders the controlled theme-icon allowlist without interpreting provider ids as behavior.
 */
export function SourceControlIcon({
    className,
    icon,
    size = 13,
}: {
    className?: string;
    icon: ModelIcon;
    size?: number;
}) {
    if (icon.kind === 'file-type')
        return <FileTypeIcon entry={{ kind: 'file', name: icon.name }} />;
    if (icon.id === 'archive') return <ArchiveIcon className={className} size={size} />;
    if (icon.id === 'discard') return <DiscardIcon className={className} size={size} />;
    if (icon.id === 'diff-multiple') return <DiffMultipleIcon className={className} size={size} />;
    if (icon.id === 'repo') return <RepoIcon className={className} size={size} />;
    if (icon.id === 'sync') return <SyncIcon className={className} size={size} />;
    const Icon = icons[icon.id] ?? Package;
    return <Icon className={className} size={size} />;
}
