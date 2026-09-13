import type { TreeItemDto } from '@caxri/protocol';
import {
    AlertTriangle,
    Check,
    Circle,
    CircleArrowUp,
    CircleCheck,
    CircleDot,
    CircleSlash,
    CircleX,
    Cloud,
    EyeOff,
    File,
    GitBranch,
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    MessageSquareWarning,
    Monitor,
    Package,
    Rocket,
} from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { DeploymentPreviewIcon } from '../../icons/deployment-preview-icon';
import type { LinearStatusKind } from '../../icons/linear/linear-status-icon';
import { LinearStatusIcon } from '../../icons/linear/linear-status-icon';
import { cn } from '../../lib/utilities';

const themeIcons = {
    'check': Check,
    'circle-check': CircleCheck,
    'circle-arrow-up': CircleArrowUp,
    'circle-dot': CircleDot,
    'circle-outline': Circle,
    'circle-slash': CircleSlash,
    'deployment-preview': DeploymentPreviewIcon,
    'circle-x': CircleX,
    'cloud': Cloud,
    'error': AlertTriangle,
    'eye-off': EyeOff,
    'file': File,
    'folder': Package,
    'git-branch': GitBranch,
    'git-merge': GitMerge,
    'git-pull-request': GitPullRequest,
    'git-pull-request-open': GitPullRequest,
    'git-pull-request-closed': GitPullRequestClosed,
    'git-pull-request-draft': GitPullRequestDraft,
    'issues': MessageSquareWarning,
    'monitor': Monitor,
    'package': Package,
    'pass': Check,
    'question': Circle,
    'repo': Package,
    'rocket': Rocket,
    'symbol-string': File,
    'warning': AlertTriangle,
} as const;

const linearStatusIconKinds = {
    'linear-backlog': 'backlog',
    'linear-canceled': 'canceled',
    'linear-completed': 'completed',
    'linear-started': 'started',
    'linear-triage': 'triage',
    'linear-unstarted': 'unstarted',
} as const satisfies Record<string, LinearStatusKind>;

type LinearStatusIconId = keyof typeof linearStatusIconKinds;
type ThemeIconId = keyof typeof themeIcons | LinearStatusIconId;

const themeIconClassNames: Partial<Record<ThemeIconId, string>> = {
    'check': 'text-success',
    'circle-check': 'text-success',
    'circle-dot': 'text-muted',
    'circle-outline': 'text-muted',
    'circle-slash': 'text-muted',
    'circle-x': 'text-danger',
    'error': 'text-danger',
    'git-merge': 'text-merged',
    'git-pull-request-open': 'text-success',
    'git-pull-request-closed': 'text-danger',
    'git-pull-request-draft': 'text-muted',
    'linear-backlog': 'text-muted',
    'linear-canceled': 'text-muted',
    'linear-completed': 'text-success',
    'linear-started': 'text-warning',
    'linear-triage': 'text-warning',
    'linear-unstarted': 'text-muted',
    'pass': 'text-success',
    'question': 'text-muted',
    'warning': 'text-warning',
};

function themeIconId(icon: TreeItemDto['icon']): string | undefined {
    return icon?.kind === 'theme' ? icon.id : undefined;
}

function isLinearStatusIconId(iconId: string | undefined): iconId is LinearStatusIconId {
    return iconId !== undefined && iconId in linearStatusIconKinds;
}

export function ExtensionTreeItemIcon({
    className,
    icon,
    size,
}: {
    className?: string;
    icon: TreeItemDto['icon'];
    size: number;
}) {
    const iconId = themeIconId(icon);
    if (iconId === 'loading')
        return (
            <Spinner
                aria-hidden="true"
                className={cn(className, 'text-warning')}
                data-theme-icon={iconId}
                size={size}
                style={{ width: size, height: size }}
            />
        );
    const iconClassName = iconId ? themeIconClassNames[iconId as ThemeIconId] : undefined;
    if (isLinearStatusIconId(iconId))
        return (
            <LinearStatusIcon
                kind={linearStatusIconKinds[iconId]}
                className={cn(className, iconClassName)}
                data-theme-icon={iconId}
                size={size}
            />
        );
    const Icon =
        iconId && iconId in themeIcons ? themeIcons[iconId as keyof typeof themeIcons] : File;
    return <Icon className={cn(className, iconClassName)} data-theme-icon={iconId} size={size} />;
}

export function ExtensionTreeTrailingIcon({ icon }: { icon: TreeItemDto['trailingIcon'] }) {
    const iconId = themeIconId(icon);
    if (iconId === 'loading')
        return (
            <Spinner
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted"
                data-theme-icon={iconId}
            />
        );
    if (!iconId || !(iconId in themeIcons)) return null;
    const Icon = themeIcons[iconId as keyof typeof themeIcons];
    return (
        <Icon
            aria-hidden="true"
            className="shrink-0 text-muted"
            data-theme-icon={iconId}
            size={14}
        />
    );
}
