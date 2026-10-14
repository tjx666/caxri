import type { ComponentType } from 'react';
import { ActivityIndicator } from 'react-native';
import Svg, { Circle as SvgCircle, Defs, G, Mask, Path, Rect } from 'react-native-svg';

import type { MethodResult } from '@caxri/protocol';
import type { LucideProps } from 'lucide-react-native';
import {
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
    Send,
    Shield,
    ShieldAlert,
    ShieldCheck,
    ShieldEllipsis,
    ShieldMinus,
    ShieldX,
    TriangleAlert,
} from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';

type TreeIcon = NonNullable<MethodResult<'mobile.tree.children'>['items'][number]['icon']>;
interface GlyphProperties {
    color: string;
    size: number;
}

/**
 * VS Code codicons Desktop vendors for Source Control rows (`repo`, `archive`, `worktree`), so a repository, a
 * submodule, and a worktree read the same on the phone as in Desktop's Status panel.
 *
 * Source: https://github.com/microsoft/vscode-codicons (CC BY 4.0, `licenses/VSCODE_CODICONS_LICENSE.txt`).
 */
const codicon =
    (path: string) =>
    ({ color, size }: GlyphProperties) => (
        <Svg fill={color} height={size} viewBox="0 0 16 16" width={size}>
            <Path d={path} />
        </Svg>
    );

const RepoGlyph = codicon(
    'M12.5 12C12.776 12 13 11.776 13 11.5V3C13 1.895 12.105 1 11 1H5C3.895 1 3 1.895 3 3V13C3 14.105 3.895 15 5 15V15.5C5 15.702 5.122 15.885 5.309 15.962C5.495 16.039 5.711 15.997 5.854 15.854L6.5 15.208L7.146 15.854C7.242 15.95 7.37 16 7.5 16C7.564 16 7.63 15.987 7.691 15.962C7.878 15.885 8 15.702 8 15.5V15H12.5C12.776 15 13 14.776 13 14.5C13 14.224 12.776 14 12.5 14H8V13.5C8 13.224 7.776 13 7.5 13H5.5C5.224 13 5 13.224 5 13.5V14C4.448 14 4 13.552 4 13V12H12.5ZM4 3C4 2.448 4.448 2 5 2H11C11.552 2 12 2.448 12 3V11H4V3Z',
);
const ArchiveGlyph = codicon(
    'M6.5 8C6.22386 8 6 8.22386 6 8.5C6 8.77614 6.22386 9 6.5 9H9.5C9.77614 9 10 8.77614 10 8.5C10 8.22386 9.77614 8 9.5 8H6.5ZM1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V4.5C15 5.15311 14.5826 5.70873 14 5.91465V11.5C14 12.8807 12.8807 14 11.5 14H4.5C3.11929 14 2 12.8807 2 11.5V5.91465C1.4174 5.70873 1 5.15311 1 4.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V4.5C2 4.77614 2.22386 5 2.5 5H13.5C13.7761 5 14 4.77614 14 4.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5ZM3 6V11.5C3 12.3284 3.67157 13 4.5 13H11.5C12.3284 13 13 12.3284 13 11.5V6H3Z',
);
const WorktreeGlyph = codicon(
    'M12.854 14.8542L14.854 12.8542C15.049 12.6592 15.049 12.3422 14.854 12.1472L12.854 10.1472C12.659 9.95223 12.342 9.95223 12.147 10.1472C11.952 10.3422 11.952 10.6592 12.147 10.8542L13.293 12.0002H8.5C8.225 12.0002 8 11.7752 8 11.5002V5.50023C8 5.22523 8.225 5.00023 8.5 5.00023H13.293L12.147 6.14623C12.049 6.24423 12.001 6.37223 12.001 6.50023C12.001 6.62823 12.05 6.75623 12.147 6.85423C12.342 7.04923 12.659 7.04923 12.854 6.85423L14.854 4.85423C15.049 4.65923 15.049 4.34223 14.854 4.14723L12.854 2.14723C12.659 1.95223 12.342 1.95223 12.147 2.14723C11.952 2.34223 11.952 2.65923 12.147 2.85423L13.293 4.00023H8.5C7.673 4.00023 7 4.67323 7 5.50023V8.00023H1.5C1.224 8.00023 1 8.22423 1 8.50023C1 8.77623 1.224 9.00023 1.5 9.00023H7V11.5002C7 12.3272 7.673 13.0002 8.5 13.0002H13.293L12.147 14.1462C12.049 14.2442 12.001 14.3722 12.001 14.5002C12.001 14.6282 12.05 14.7562 12.147 14.8542C12.342 15.0492 12.659 15.0492 12.854 14.8542Z',
);

/**
 * Desktop's `DeploymentPreviewIcon`: an eye with a magnifier, distinct from the hidden-state `eye-off` glyph.
 */
const DeploymentPreviewGlyph = ({ color, size }: GlyphProperties) => (
    <Svg
        fill="none"
        height={size}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.3}
        viewBox="0 0 16 16"
        width={size}
    >
        <Path d="M8.5 11C5.3 11.3 2.8 10 1 7.5C4 2.5 11 2.5 14.5 7.5C13.7 8.8 12.7 9.7 11.5 10.3" />
        <SvgCircle cx="7.25" cy="7.25" r="2.5" />
        <Path d="m9.05 9.05 3.2 3.2" />
    </Svg>
);

type LinearStatusKind =
    'backlog' | 'canceled' | 'completed' | 'duplicate' | 'started' | 'triage' | 'unstarted';

const LINEAR_CUTOUTS: Partial<Record<LinearStatusKind, string>> = {
    triage: 'M6.15 6.4C6.35 5.35 7.05 4.8 8.1 4.8c1.2 0 2 .65 2 1.65 0 .9-.55 1.35-1.2 1.75-.65.4-.9.75-.9 1.45M8 11.35h.01',
    completed: 'm4.75 8.15 2.25 2.1 4.4-4.55',
    canceled: 'm5.1 5.1 5.8 5.8M10.9 5.1l-5.8 5.8',
    duplicate: 'M6.25 5.25h4.5v4.5h-4.5zM5.25 6.25v4.5h4.5',
};

/**
 * Mirrors Desktop's Caxri-owned Linear workflow glyphs.
 */
const LinearStatusGlyph = ({ color, kind, size }: GlyphProperties & { kind: LinearStatusKind }) => {
    const cutout = LINEAR_CUTOUTS[kind];
    const maskId = `linear-${kind}-cutout`;
    return (
        <Svg fill="none" height={size} viewBox="0 0 16 16" width={size}>
            {kind === 'backlog' ? (
                <>
                    <Rect
                        height="12"
                        rx="3.5"
                        stroke={color}
                        strokeWidth="1.5"
                        width="12"
                        x="2"
                        y="2"
                    />
                    <Path
                        d="M5 5.5h6M5 8h6M5 10.5h4"
                        stroke={color}
                        strokeLinecap="round"
                        strokeWidth="1.25"
                    />
                </>
            ) : null}
            {kind === 'unstarted' ? (
                <Rect
                    height="12"
                    rx="3.5"
                    stroke={color}
                    strokeWidth="1.5"
                    width="12"
                    x="2"
                    y="2"
                />
            ) : null}
            {kind === 'started' ? (
                <>
                    <Rect
                        height="12"
                        rx="3.5"
                        stroke={color}
                        strokeWidth="1.5"
                        width="12"
                        x="2"
                        y="2"
                    />
                    <Path
                        d="M5 8h6M9 5.75 11.25 8 9 10.25"
                        stroke={color}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                    />
                </>
            ) : null}
            {cutout ? (
                <>
                    <Defs>
                        <Mask
                            height="16"
                            id={maskId}
                            maskUnits="userSpaceOnUse"
                            width="16"
                            x="0"
                            y="0"
                        >
                            <Rect fill="white" height="16" width="16" />
                            <G
                                fill="none"
                                stroke="black"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="1.65"
                            >
                                <Path d={cutout} />
                            </G>
                        </Mask>
                    </Defs>
                    <Rect
                        fill={color}
                        height="12"
                        mask={`url(#${maskId})`}
                        rx="3.5"
                        width="12"
                        x="2"
                        y="2"
                    />
                </>
            ) : null}
        </Svg>
    );
};

const lucide =
    (Icon: ComponentType<LucideProps>) =>
    ({ color, size }: GlyphProperties) => <Icon color={color} size={size} strokeWidth={2} />;

/**
 * The same id → glyph table as Desktop's `extension-tree-item-icon.tsx`, so a Status row means the same thing on both
 * surfaces.
 */
const THEME_GLYPHS: Partial<Record<string, ComponentType<GlyphProperties>>> = {
    'archive': ArchiveGlyph,
    'check': lucide(Check),
    'circle-check': lucide(CircleCheck),
    'circle-check-merged': lucide(CircleCheck),
    'circle-arrow-up': lucide(CircleArrowUp),
    'circle-dot': lucide(CircleDot),
    'circle-outline': lucide(Circle),
    'circle-slash': lucide(CircleSlash),
    'circle-small-filled': lucide(CircleSmall),
    'circle-x': lucide(CircleX),
    'cloud': lucide(Cloud),
    'comment': lucide(MessageSquare),
    'comment-unresolved': lucide(MessageSquareDot),
    'deployment-preview': DeploymentPreviewGlyph,
    'error': lucide(TriangleAlert),
    'eye-off': lucide(EyeOff),
    'file': lucide(File),
    'folder': lucide(Package),
    'git-branch': lucide(GitBranch),
    'git-merge': lucide(GitMerge),
    'git-pull-request': lucide(GitPullRequest),
    'git-pull-request-open': lucide(GitPullRequest),
    'git-pull-request-closed': lucide(GitPullRequestClosed),
    'git-pull-request-draft': lucide(GitPullRequestDraft),
    'hourglass': lucide(Hourglass),
    'issues': lucide(MessageSquareWarning),
    'monitor': lucide(Monitor),
    'package': lucide(Package),
    'pass': lucide(Check),
    'question': lucide(Circle),
    'repo': RepoGlyph,
    'rocket': lucide(Rocket),
    'rocket-success': lucide(Rocket),
    'send': lucide(Send),
    'shield': lucide(Shield),
    'shield-alert': lucide(ShieldAlert),
    'shield-check': lucide(ShieldCheck),
    'shield-ellipsis': lucide(ShieldEllipsis),
    'shield-minus': lucide(ShieldMinus),
    'shield-x': lucide(ShieldX),
    'symbol-string': lucide(File),
    'warning': lucide(TriangleAlert),
    'worktree': WorktreeGlyph,
};

type Tone = 'danger' | 'merged' | 'muted' | 'success' | 'warning';

/**
 * Desktop's `themeIconClassNames`: glyphs that carry a state take its semantic color; everything else inherits the row.
 */
const THEME_TONES: Partial<Record<string, Tone>> = {
    'check': 'success',
    'circle-check': 'success',
    // Violet like Desktop's: a merged pull request's passing checks are settled history, not work in flight.
    'circle-check-merged': 'merged',
    'circle-dot': 'muted',
    'circle-outline': 'muted',
    'circle-slash': 'muted',
    'circle-small-filled': 'warning',
    'circle-x': 'danger',
    'comment': 'muted',
    'comment-unresolved': 'warning',
    'error': 'danger',
    'git-merge': 'merged',
    'git-pull-request-open': 'success',
    'git-pull-request-closed': 'danger',
    'git-pull-request-draft': 'muted',
    'hourglass': 'muted',
    'pass': 'success',
    'question': 'muted',
    // Violet like Desktop's: a shipped deployment is where a merged pull request goes next.
    'rocket-success': 'merged',
    'shield': 'muted',
    'shield-alert': 'danger',
    'shield-check': 'success',
    'shield-ellipsis': 'warning',
    'shield-minus': 'muted',
    'shield-x': 'danger',
    'warning': 'warning',
};

const FallbackGlyph = lucide(File);

const LINEAR_KINDS: Partial<Record<string, LinearStatusKind>> = {
    'linear-backlog': 'backlog',
    'linear-canceled': 'canceled',
    'linear-completed': 'completed',
    'linear-duplicate': 'duplicate',
    'linear-started': 'started',
    'linear-triage': 'triage',
    'linear-unstarted': 'unstarted',
};

export const TreeItemIcon = ({
    icon,
    size = 16,
    theme,
}: {
    icon: TreeIcon | undefined;
    size?: number;
    theme: MobileTheme;
}) => {
    const id = icon?.kind === 'theme' ? icon.id : undefined;
    if (id === 'loading') return <ActivityIndicator color={theme.warning} size={size} />;
    const linearKind = id ? LINEAR_KINDS[id] : undefined;
    /**
     * Only a Linear workflow state carries an externally owned color; without it the glyph shape still separates
     * states.
     */
    if (linearKind)
        return (
            <LinearStatusGlyph color={icon?.color ?? theme.muted} kind={linearKind} size={size} />
        );
    const Glyph = (id ? THEME_GLYPHS[id] : undefined) ?? FallbackGlyph;
    const tone = id ? THEME_TONES[id] : undefined;
    return <Glyph color={icon?.color ?? (tone ? theme[tone] : theme.text)} size={size} />;
};
