import {
    agentTranscriptTabLabel,
    filePreviewTabLabel,
    gitDiffTabLabel,
    isSettingsTabPath,
    isUsageTabPath,
    parseAgentTranscriptTab,
    parseExternalEditorTab,
    parseFilePreviewTab,
    parseGitDiffTab,
    SETTINGS_TAB_LABEL,
    USAGE_TAB_LABEL,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

/**
 * Keeps resource labels and filesystem hover paths consistent without branching inside tab rendering.
 */
export function documentTabPresentation(
    path: string,
    options: { displayPath?: string; transcriptTitle?: string },
) {
    const diff = parseGitDiffTab(path);
    const transcript = parseAgentTranscriptTab(path);
    const external = parseExternalEditorTab(path);
    const preview = parseFilePreviewTab(path);
    const isSettings = isSettingsTabPath(path);
    const isUsage = isUsageTabPath(path);
    const label = diff
        ? gitDiffTabLabel(diff)
        : transcript
          ? agentTranscriptTabLabel(options.transcriptTitle)
          : preview
            ? filePreviewTabLabel(preview.path)
            : isSettings
              ? SETTINGS_TAB_LABEL
              : isUsage
                ? USAGE_TAB_LABEL
                : (external?.name ?? pathBasename(path));
    return {
        fileIconName:
            diff?.kind === 'file'
                ? pathBasename(diff.path)
                : diff?.kind === 'changes'
                  ? 'changes.diff'
                  : transcript
                    ? 'transcript.jsonl'
                    : preview
                      ? pathBasename(preview.path)
                      : isSettings || isUsage
                        ? undefined
                        : (external?.name ?? pathBasename(path)),
        // Settings draws its own glyph, as VS Code's Settings editor tab does, instead of the JSON file it is stored in.
        icon: isSettings ? ('settings' as const) : isUsage ? ('usage' as const) : ('file' as const),
        label,
        // A preview tab shows its source path: the label already says "Preview", so the tooltip's job is locating it.
        labelTooltip: preview
            ? preview.path
            : diff || transcript || isSettings || isUsage
              ? label
              : (options.displayPath ?? external?.name ?? path),
    };
}
