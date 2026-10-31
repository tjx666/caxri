import type { GitDiffTab, VirtualEditorTabScheme } from '@caxri/protocol';
import {
    gitDiffTabLabel,
    parseExternalEditorTab,
    parseFilePreviewTab,
    parseGitDiffTab,
    parseUntitledEditorTab,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import type { Translate, TranslationKey } from '../../i18n';
import { PREVIEW_LOADING_LABEL_KEY, shouldOpenAsPreview } from '../preview/preview-registry';
import type { WorkTabGlyph } from '../tabs/work-tab-glyphs';

/**
 * Per-tab inputs a virtual tab's label and tooltip may draw on. Only the fields a scheme names are read.
 */
export interface VirtualTabPresentationOptions {
    /**
     * Display name of the Agent an `agentStatusTabPath` tab describes, once its Terminal is known.
     */
    agentName?: string;
    /**
     * Title of the Terminal an `agentStatusTabPath` or `agentContextTabPath` tab describes. Two such tabs for the same
     * Agent share a label, so the tooltip names the Terminal to tell them apart.
     */
    agentTerminalTitle?: string;
    displayPath?: string;
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
    /**
     * Name an untitled buffer takes from its first line, when that line has one.
     */
    untitledName?: string;
    /**
     * File extension of the language detected in an untitled buffer, so its tab shows that language's file icon.
     */
    untitledLanguageExtension?: string;
}

/**
 * What the tab rail needs to draw one tab.
 */
interface VirtualTabPresentation {
    /**
     * `file` resolves a file type icon from `fileIconName`; anything else is a dedicated glyph.
     */
    icon: 'file' | WorkTabGlyph;
    /**
     * File name the icon theme resolves, or `undefined` when the tab draws a dedicated glyph instead.
     */
    fileIconName: string | undefined;
    label: string;
    labelTooltip: string;
}

/**
 * Everything the Renderer needs to know about one virtual tab scheme. `virtualTabDescriptors` is keyed by the
 * protocol's `VirtualEditorTabScheme`, so a scheme added there without an entry here fails typecheck. The matching
 * surface component lives in `editor-surface.tsx` under the same exhaustive key.
 */
interface VirtualTabDescriptor {
    /**
     * Label, icon, and tooltip for a path of this scheme.
     */
    present: (
        path: string,
        options: VirtualTabPresentationOptions,
        t: Translate,
    ) => VirtualTabPresentation;
    /**
     * Placeholder shown while the surface's lazy module loads, or `undefined` when the surface renders inline.
     */
    loading: { labelKey: TranslationKey; variant: 'document' | 'page' } | undefined;
    /**
     * How much file status the status bar shows: `cursorOnly` for a tab whose editor still publishes cursor and
     * language (an external document), `hidden` for a tab with no cursor of its own. A Project file shows `full`.
     */
    statusBar: 'cursorOnly' | 'hidden';
}

function diffTabLabel(tab: GitDiffTab, t: Translate): string {
    if (tab.kind !== 'changes') return gitDiffTabLabel(tab);
    return t(
        tab.source === 'pull-request' ? 'editor.tab.pullRequestChanges' : 'editor.tab.changes',
        {
            repository: tab.repositoryName,
        },
    );
}

function transcriptTabLabel(terminalTitle: string | undefined, t: Translate): string {
    return terminalTitle
        ? t('editor.tab.transcriptNamed', { title: terminalTitle })
        : t('editor.tab.transcript');
}

function taskTabLabel(
    task: { kind: 'agent' | 'shell'; title: string } | undefined,
    t: Translate,
): string {
    const title = task?.title.trim();
    if (title) return title;
    return task?.kind === 'shell' ? 'Shell' : t('editor.tab.subagent');
}

function previewTabLabel(path: string, t: Translate): string {
    const external = parseExternalEditorTab(path);
    const name = external ? external.name : path.slice(path.lastIndexOf('/') + 1);
    return shouldOpenAsPreview(path) ? name : t('editor.tab.preview', { name });
}

/**
 * A tab whose tooltip is its label and whose icon is a file type icon resolved from `fileIconName`.
 */
function fileIconPresentation(label: string, fileIconName: string | undefined) {
    return { icon: 'file' as const, fileIconName, label, labelTooltip: label };
}

/**
 * A tab with its own glyph, so no file type icon applies.
 */
function glyphPresentation(label: string, icon: WorkTabGlyph, labelTooltip = label) {
    return { icon, fileIconName: undefined, label, labelTooltip };
}

/**
 * Agent status and context tabs share a label per Agent, so the tooltip names the Terminal that tells them apart.
 */
function terminalScopedTooltip(label: string, options: VirtualTabPresentationOptions): string {
    return options.agentTerminalTitle ? `${label} · ${options.agentTerminalTitle}` : label;
}

export const virtualTabDescriptors: Record<VirtualEditorTabScheme, VirtualTabDescriptor> = {
    gitDiff: {
        present: (path, _options, t) => {
            const diff = parseGitDiffTab(path);
            const label = diff ? diffTabLabel(diff, t) : pathBasename(path);
            if (diff?.kind === 'file') return fileIconPresentation(label, pathBasename(diff.path));
            return fileIconPresentation(
                label,
                diff?.kind === 'changes' ? 'changes.diff' : pathBasename(path),
            );
        },
        loading: { labelKey: 'editor.load.loadingDiffEditor', variant: 'document' },
        statusBar: 'hidden',
    },
    agentTranscript: {
        present: (_path, options, t) =>
            fileIconPresentation(
                transcriptTabLabel(options.transcriptTitle, t),
                'transcript.jsonl',
            ),
        loading: { labelKey: 'editor.load.loadingTranscript', variant: 'document' },
        statusBar: 'hidden',
    },
    agentTask: {
        present: (_path, options, t) =>
            glyphPresentation(
                taskTabLabel(options.task, t),
                options.task?.kind === 'shell' ? 'shell-task' : 'agent-task',
            ),
        loading: { labelKey: 'editor.load.loadingTask', variant: 'document' },
        statusBar: 'hidden',
    },
    agentTurnReview: {
        present: (_path, _options, t) =>
            fileIconPresentation(t('editor.tab.turnChanges'), 'changes.diff'),
        loading: { labelKey: 'editor.load.loadingChanges', variant: 'document' },
        statusBar: 'hidden',
    },
    agentStatus: {
        present: (_path, options, t) => {
            const label = t('editor.tab.agentStatus', { agent: options.agentName ?? 'Agent' });
            return glyphPresentation(label, 'agent-status', terminalScopedTooltip(label, options));
        },
        loading: { labelKey: 'editor.load.loadingAgentStatus', variant: 'page' },
        statusBar: 'hidden',
    },
    agentContext: {
        present: (_path, options, t) => {
            const label = t('editor.tab.agentContext');
            return glyphPresentation(label, 'agent-context', terminalScopedTooltip(label, options));
        },
        loading: { labelKey: 'editor.load.loadingAgentContext', variant: 'page' },
        statusBar: 'hidden',
    },
    agentSideChat: {
        present: (_path, options, t) => {
            const label = t('editor.tab.agentSideChat');
            return glyphPresentation(
                label,
                'agent-side-chat',
                terminalScopedTooltip(label, options),
            );
        },
        loading: { labelKey: 'editor.load.loadingAgentSideChat', variant: 'page' },
        statusBar: 'hidden',
    },
    environment: {
        present: (_path, _options, t) =>
            glyphPresentation(t('editor.tab.environment'), 'environment'),
        loading: { labelKey: 'editor.load.loadingEnvironment', variant: 'page' },
        statusBar: 'hidden',
    },
    external: {
        present: (path, options) => {
            const name = parseExternalEditorTab(path)?.name ?? pathBasename(path);
            return {
                icon: 'file',
                fileIconName: name,
                label: name,
                labelTooltip: options.displayPath ?? name,
            };
        },
        loading: undefined,
        statusBar: 'cursorOnly',
    },
    // Named like VS Code's untitled editors: the first line once it has text, `Untitled-N` before that.
    untitled: {
        present: (path, options, t) => {
            const fallback = t('editor.tab.untitled', { index: parseUntitledEditorTab(path) ?? 1 });
            const extension = options.untitledLanguageExtension;
            return {
                icon: 'file',
                fileIconName: extension ? `${fallback}.${extension}` : fallback,
                label: options.untitledName ?? fallback,
                labelTooltip: fallback,
            };
        },
        loading: undefined,
        statusBar: 'cursorOnly',
    },
    filePreview: {
        present: (path, options, t) => {
            const preview = parseFilePreviewTab(path);
            if (!preview) return fileIconPresentation(pathBasename(path), pathBasename(path));
            const external = parseExternalEditorTab(preview.path);
            return {
                icon: 'file',
                fileIconName: pathBasename(preview.path),
                label: previewTabLabel(preview.path, t),
                // The label already says "Preview", so the tooltip's job is locating the source.
                labelTooltip: external
                    ? (options.previewSourceDisplayPath ?? external.name)
                    : preview.path,
            };
        },
        loading: { labelKey: PREVIEW_LOADING_LABEL_KEY, variant: 'document' },
        statusBar: 'hidden',
    },
    usage: {
        present: (_path, _options, t) => glyphPresentation(t('editor.tab.usage'), 'usage'),
        loading: { labelKey: 'editor.load.loadingUsage', variant: 'page' },
        statusBar: 'hidden',
    },
};
