import type { TreeItemDto } from '@caxri/protocol';
import {
    AlertTriangle,
    Check,
    Circle,
    CircleArrowUp,
    CircleCheck,
    CircleDot,
    CircleSlash,
    CircleSmall,
    CircleX,
    Cloud,
    EyeOff,
    File,
    GitBranch,
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    Hourglass,
    MessageSquare,
    MessageSquareDot,
    MessageSquareWarning,
    Monitor,
    Package,
    Rocket,
    Shield,
    ShieldAlert,
    ShieldCheck,
    ShieldEllipsis,
    ShieldMinus,
    ShieldX,
} from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { ArchiveIcon } from '../../icons/codicons/archive-icon';
import { RepoIcon } from '../../icons/codicons/repo-icon';
import { WorktreeIcon } from '../../icons/codicons/worktree-icon';
import { DeploymentPreviewIcon } from '../../icons/deployment-preview-icon';
import type { LinearStatusKind } from '../../icons/linear/linear-status-icon';
import { LinearStatusIcon } from '../../icons/linear/linear-status-icon';
import { cn } from '../../lib/utilities';

/**
 * `repo`, `worktree` and `archive` are VS Code's own Source Control glyphs rather than lucide approximations, so a
 * repository, a linked worktree and a submodule read the same here as in the editor most contributors also have open.
 */
const themeIcons = {
    'archive': ArchiveIcon,
    'check': Check,
    'circle-check': CircleCheck,
    'circle-arrow-up': CircleArrowUp,
    'circle-dot': CircleDot,
    'circle-outline': Circle,
    'circle-slash': CircleSlash,
    /**
     * A check that has been accepted and has not started. Filled rather than hollow so it reads as a state of its own
     * beside `circle-outline`, which is the neutral conclusion GitHub draws with an empty ring.
     */
    'circle-small-filled': CircleSmall,
    'deployment-preview': DeploymentPreviewIcon,
    'circle-x': CircleX,
    'cloud': Cloud,
    'comment': MessageSquare,
    /**
     * A review thread still waiting on the author. The dot marks it as owed rather than read, which the plain `comment`
     * glyph of each individual thread row does not claim.
     */
    'comment-unresolved': MessageSquareDot,
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
    /**
     * A provider that will answer again once its own clock runs out. Deliberately not `circle-x`: a rate limit is a
     * wait, and dressing it as a failure told the user to fix something that fixes itself.
     */
    'hourglass': Hourglass,
    'issues': MessageSquareWarning,
    'monitor': Monitor,
    'package': Package,
    'pass': Check,
    'question': Circle,
    'repo': RepoIcon,
    'rocket': Rocket,
    /**
     * A production deployment that succeeded, which is the one row on this panel that means the work is live. It keeps
     * the rocket's shape and adds the success tone `themeIconClassNames` gives it, because the plain rocket is also the
     * Deployments group's glyph, where it counts deployments and asserts nothing about how they went.
     */
    'rocket-success': Rocket,
    /**
     * The acceptance report family. A shield is not a state glyph here: it says the row is a human sign-off rather than
     * a machine verdict, and only the interior symbol changes with the state.
     */
    'shield': Shield,
    'shield-alert': ShieldAlert,
    'shield-check': ShieldCheck,
    'shield-ellipsis': ShieldEllipsis,
    'shield-minus': ShieldMinus,
    'shield-x': ShieldX,
    'symbol-string': File,
    'warning': AlertTriangle,
    'worktree': WorktreeIcon,
} as const;

const linearStatusIconKinds = {
    'linear-backlog': 'backlog',
    'linear-canceled': 'canceled',
    'linear-completed': 'completed',
    'linear-duplicate': 'duplicate',
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
    'circle-small-filled': 'fill-current text-warning',
    'circle-x': 'text-danger',
    'comment': 'text-muted',
    'comment-unresolved': 'text-warning',
    'error': 'text-danger',
    'git-merge': 'text-merged',
    'git-pull-request-open': 'text-success',
    'git-pull-request-closed': 'text-danger',
    'git-pull-request-draft': 'text-muted',
    'hourglass': 'text-muted',
    'pass': 'text-success',
    'question': 'text-muted',
    // Violet like the Session row's rocket: a shipped deployment is where a merged pull request goes next.
    'rocket-success': 'text-merged',
    'shield': 'text-muted',
    'shield-alert': 'text-danger',
    'shield-check': 'text-success',
    'shield-ellipsis': 'text-warning',
    'shield-minus': 'text-muted',
    'shield-x': 'text-danger',
    'warning': 'text-warning',
};

function themeIconId(icon: TreeItemDto['icon']): string | undefined {
    return icon?.kind === 'theme' ? icon.id : undefined;
}

function isLinearStatusIconId(iconId: string | undefined): iconId is LinearStatusIconId {
    return iconId !== undefined && iconId in linearStatusIconKinds;
}

/**
 * The one place a tree icon may leave the theme's palette. The provider supplies this only for content whose colors an
 * external system owns (a Linear workflow state, whose color each workspace configures) and the protocol has already
 * checked it is a `#RRGGBB` literal (`viewIconSchema`). Everything Caxri defines stays on `themeIconClassNames`.
 */
function themeIconColor(icon: TreeItemDto['icon']): string | undefined {
    return icon?.kind === 'theme' ? icon.color : undefined;
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
    const color = themeIconColor(icon);
    const iconClassName = iconId ? themeIconClassNames[iconId as ThemeIconId] : undefined;
    if (isLinearStatusIconId(iconId))
        return (
            <LinearStatusIcon
                kind={linearStatusIconKinds[iconId]}
                // Without the workspace's own color the glyph's shape still separates the states, so it falls back to
                // the row's muted color rather than to a semantic token that would assert a meaning Linear never gave.
                className={cn(className, !color && 'text-muted')}
                data-theme-icon={iconId}
                size={size}
                style={color ? { color } : undefined}
            />
        );
    const Icon =
        iconId && iconId in themeIcons ? themeIcons[iconId as keyof typeof themeIcons] : File;
    return (
        <Icon
            className={cn(className, iconClassName)}
            data-theme-icon={iconId}
            size={size}
            style={color ? { color } : undefined}
        />
    );
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
            /**
             * The same palette the leading slot uses. A glyph that carries a state (a pull request's merged, open, or
             * draft lifecycle) means the same thing in either slot, so moving it here must not drain its color; the
             * trailing slot's original occupant, a deployment environment, has no state and so still falls back to
             * `--muted`.
             */
            className={cn('shrink-0', themeIconClassNames[iconId as ThemeIconId] ?? 'text-muted')}
            data-theme-icon={iconId}
            size={14}
        />
    );
}

/**
 * An inline action's glyph. It deliberately skips `themeIconClassNames`: on a button the icon names an action rather
 * than a state, so it takes the button's own foreground instead of, say, the merged violet `git-merge` wears as a row
 * icon.
 */
export function ExtensionTreeActionIcon({ icon }: { icon: TreeItemDto['icon'] }) {
    const iconId = themeIconId(icon);
    const Icon =
        iconId && iconId in themeIcons ? themeIcons[iconId as keyof typeof themeIcons] : File;
    return <Icon aria-hidden="true" data-theme-icon={iconId} size={14} />;
}
