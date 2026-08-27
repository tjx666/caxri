import type { SourceControlViewModel } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    FileDiff,
    FileText,
    FolderGit2,
    GitCommitHorizontal,
    GitPullRequest,
    Package,
    RefreshCw,
} from 'lucide-react';

import { DiffMultipleIcon } from '../../../icons/codicons/diff-multiple-icon';
import { DiscardIcon } from '../../../icons/codicons/discard-icon';
import { FileSubmoduleIcon } from '../../../icons/codicons/file-submodule-icon';
import { SyncIcon } from '../../../icons/codicons/sync-icon';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';

type ModelIcon = SourceControlViewModel['refreshAction']['icon'];

const icons: Readonly<Record<string, LucideIcon>> = {
    'diff': FileDiff,
    'file': FileText,
    'folder-git': FolderGit2,
    'git-commit': GitCommitHorizontal,
    'git-pull-request': GitPullRequest,
    'refresh': RefreshCw,
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
    if (icon.id === 'discard') return <DiscardIcon className={className} size={size} />;
    if (icon.id === 'diff-multiple') return <DiffMultipleIcon className={className} size={size} />;
    if (icon.id === 'file-submodule')
        return <FileSubmoduleIcon className={className} size={size} />;
    if (icon.id === 'sync') return <SyncIcon className={className} size={size} />;
    const Icon = icons[icon.id] ?? Package;
    return <Icon className={className} size={size} />;
}
