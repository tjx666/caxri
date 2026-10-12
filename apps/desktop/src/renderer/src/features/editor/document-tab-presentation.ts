import {
    agentStatusTabLabel,
    agentTaskTabLabel,
    agentTranscriptTabLabel,
    filePreviewTabLabel,
    gitDiffTabLabel,
    isSettingsTabPath,
    isUsageTabPath,
    parseAgentStatusTab,
    parseAgentTaskTab,
    parseAgentTranscriptTab,
    parseAgentTurnReviewTab,
    parseExternalEditorTab,
    parseFilePreviewTab,
    parseGitDiffTab,
    SETTINGS_TAB_LABEL,
    USAGE_TAB_LABEL,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { shouldOpenAsPreview } from '../preview/preview-registry';

const OUTSIDE_PROJECT_DESCRIPTION = 'Outside every Project';

function directorySegments(displayPath: string): string[] {
    return displayPath.split('/').slice(0, -1).filter(Boolean);
}

/**
 * The shortest trailing run of parent directories that tells `displayPath` apart from every other open external file
 * with the same name, or `undefined` when its name is unique. Mirrors VS Code's tab descriptions: a lone `README.md`
 * stays bare, two of them read `api` and `web`, and deeper collisions widen to `packages/api`.
 */
export function externalTabParentLabel(
    displayPath: string,
    externalDisplayPaths: readonly string[],
): string | undefined {
    const name = pathBasename(displayPath);
    const others = [...new Set(externalDisplayPaths)]
        .filter((other) => other !== displayPath && pathBasename(other) === name)
        .map(directorySegments);
    if (others.length === 0) return undefined;
    const own = directorySegments(displayPath);
    for (let depth = 1; depth <= own.length; depth += 1) {
        const suffix = own.slice(-depth).join('/');
        if (others.every((segments) => segments.slice(-depth).join('/') !== suffix)) return suffix;
    }
    return own.length > 0 ? `/${own.join('/')}` : '/';
}

/**
 * Keeps resource labels and filesystem hover paths consistent without branching inside tab rendering.
 */
export function documentTabPresentation(
    path: string,
    options: {
        /**
         * Display name of the Agent an `agentStatusTabPath` tab describes, once its Terminal is known.
         */
        agentName?: string;
        /**
         * Title of the Terminal an `agentStatusTabPath` tab describes. Two status tabs for the same Agent share a
         * label, so the tooltip names the Terminal to tell them apart.
         */
        agentTerminalTitle?: string;
        displayPath?: string;
        /**
         * Display paths of every external document open in the same Session, so an external tab whose filename repeats
         * can show the parent directory that tells it apart.
         */
        externalDisplayPaths?: readonly string[];
        /**
         * Display path of an external document a preview tab renders. The preview tab encodes the opaque
         * `caxri-external-file://` identity, which must never reach the user.
         */
        previewSourceDisplayPath?: string;
        transcriptTitle?: string;
        /**
         * The Agent Chat task an `agentTaskTabPath` tab shows, when the Chat still lists it.
         */
        task?: { kind: 'agent' | 'shell'; title: string };
    },
) {
    const diff = parseGitDiffTab(path);
    const transcript = parseAgentTranscriptTab(path);
    const agentTask = parseAgentTaskTab(path);
    const agentStatus = parseAgentStatusTab(path);
    const turnReview = parseAgentTurnReviewTab(path);
    const external = parseExternalEditorTab(path);
    const preview = parseFilePreviewTab(path);
    const previewExternal = preview ? parseExternalEditorTab(preview.path) : undefined;
    const isSettings = isSettingsTabPath(path);
    const isUsage = isUsageTabPath(path);
    const label = diff
        ? gitDiffTabLabel(diff)
        : transcript
          ? agentTranscriptTabLabel(options.transcriptTitle)
          : agentTask
            ? agentTaskTabLabel(options.task)
            : agentStatus
              ? agentStatusTabLabel(options.agentName)
              : turnReview
                ? 'Turn changes'
                : preview
                  ? filePreviewTabLabel(preview.path, {
                        isOnlyView: shouldOpenAsPreview(preview.path),
                    })
                  : isSettings
                    ? SETTINGS_TAB_LABEL
                    : isUsage
                      ? USAGE_TAB_LABEL
                      : (external?.name ?? pathBasename(path));
    const isOutsideProject = Boolean(external) || Boolean(previewExternal);
    const detail =
        external && options.displayPath
            ? externalTabParentLabel(options.displayPath, options.externalDisplayPaths ?? [])
            : undefined;
    return {
        /**
         * Spoken after the label (never replacing it): the tab is a file outside every Project.
         */
        ...(isOutsideProject && { accessibleDetail: OUTSIDE_PROJECT_DESCRIPTION }),
        /**
         * Muted parent directory shown beside a repeated external filename, the way VS Code tells same-named tabs
         * apart.
         */
        ...(detail && { detail }),
        fileIconName:
            diff?.kind === 'file'
                ? pathBasename(diff.path)
                : turnReview || diff?.kind === 'changes'
                  ? 'changes.diff'
                  : transcript
                    ? 'transcript.jsonl'
                    : preview
                      ? pathBasename(preview.path)
                      : isSettings || isUsage || agentTask || agentStatus
                        ? undefined
                        : (external?.name ?? pathBasename(path)),
        // Settings draws its own glyph, as VS Code's Settings editor tab does, instead of the JSON file it is stored in.
        icon: isSettings
            ? ('settings' as const)
            : isUsage
              ? ('usage' as const)
              : agentTask
                ? options.task?.kind === 'shell'
                    ? ('shell-task' as const)
                    : ('agent-task' as const)
                : agentStatus
                  ? ('agent-status' as const)
                  : ('file' as const),
        label,
        // A preview tab shows its source path: the label already says "Preview", so the tooltip's job is locating it.
        labelTooltip: preview
            ? previewExternal
                ? (options.previewSourceDisplayPath ?? previewExternal.name)
                : preview.path
            : agentStatus && options.agentTerminalTitle
              ? `${label} · ${options.agentTerminalTitle}`
              : diff ||
                  transcript ||
                  agentTask ||
                  agentStatus ||
                  turnReview ||
                  isSettings ||
                  isUsage
                ? label
                : (options.displayPath ?? external?.name ?? path),
    };
}
