import type { AgentProvider, PaneResource, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { redactSecretText } from '@caxri/utils';

import type { Translate } from '../../i18n';
import type { ScreenshotAnnotation } from './screenshot-annotations';
import { formatAnnotationLines } from './screenshot-annotations';

export interface BugReportDraft {
    actual: string;
    expected: string;
    steps: string;
}

/**
 * The screenshot as the Agent will see it: a temporary file it can open, plus the marks the user drew on it. The
 * annotations are repeated as text because an Agent reading only the prompt still has to know which numbered mark the
 * note belongs to before it decides whether opening the image is worth it.
 */
export interface BugReportScreenshotReference {
    annotations: readonly ScreenshotAnnotation[];
    height: number;
    path: string;
    width: number;
}

export interface BugReportContext {
    appVersion: string;
    architecture: string;
    commit: string;
    platform: string;
    project: { id: string };
    recentErrorIds: readonly string[];
    session: { id: string };
    visibleWork:
        | { kind: 'editor'; fileName: string }
        | { kind: 'none' }
        | { kind: 'terminal'; provider?: AgentProvider; terminalId: string };
}

function safeText(value: string): string {
    const withoutControls = [...value]
        .filter((character) => {
            const code = character.codePointAt(0)!;
            return !(code === 127 || (code !== 9 && code !== 10 && code !== 13 && code < 32));
        })
        .join('');
    return redactSecretText(withoutControls.replaceAll('\r\n', '\n').replaceAll('\r', '\n')).trim();
}

function screenshotSection(screenshot: BugReportScreenshotReference): string[] {
    const isAnnotated = screenshot.annotations.length > 0;
    return [
        '',
        '## Screenshot',
        `- File: \`${safeText(screenshot.path)}\` (${Math.round(screenshot.width)}×${Math.round(screenshot.height)} px${isAnnotated ? ', annotated' : ''})`,
        isAnnotated
            ? '- Open the image file above to see the marked areas.'
            : '- Open the image file above to see the captured window.',
        ...(isAnnotated
            ? ['- Annotations:', ...formatAnnotationLines(screenshot.annotations, safeText)]
            : []),
    ];
}

/**
 * Produces the complete payload from an allowlisted context model. There is deliberately no input for editor buffers,
 * Terminal output, Agent state, environment variables, or diagnostics fields.
 *
 * Reproduction steps are optional: the owner's dominant flow is a screenshot with a note per marked area, where a
 * numbered step list is either the same information twice or blank filler the Agent then has to ignore. The section is
 * omitted entirely rather than emitted empty.
 */
export function buildBugReport(
    draft: BugReportDraft,
    context: BugReportContext,
    screenshot?: BugReportScreenshotReference,
): string {
    const errorIds = context.recentErrorIds.map((id) => `  - \`${safeText(id)}\``);
    const steps = safeText(draft.steps);
    const visibleWork =
        context.visibleWork.kind === 'editor'
            ? `Editor: ${safeText(context.visibleWork.fileName)}`
            : context.visibleWork.kind === 'terminal'
              ? `${context.visibleWork.provider ? agentProviderCatalog[context.visibleWork.provider].displayName : 'Shell'} Terminal (\`${safeText(context.visibleWork.terminalId)}\`)`
              : 'No active tab';
    return [
        '# Caxri Bug Report',
        '',
        '## Actual behavior',
        safeText(draft.actual),
        '',
        '## Expected behavior',
        safeText(draft.expected),
        ...(steps ? ['', '## Reproduction steps', steps] : []),
        ...(screenshot ? screenshotSection(screenshot) : []),
        '',
        '## Caxri context',
        `- Caxri: ${safeText(context.appVersion)} (${safeText(context.commit)})`,
        `- Platform: ${safeText(context.platform)} ${safeText(context.architecture)}`,
        `- Project ID: \`${safeText(context.project.id)}\``,
        `- Session ID: \`${safeText(context.session.id)}\``,
        `- Visible work: ${visibleWork}`,
        ...(errorIds.length > 0
            ? ['- Recent error IDs:', ...errorIds]
            : ['- Recent error IDs: none']),
    ].join('\n');
}

/**
 * Live candidates only; the Server repeats these checks atomically when the user sends.
 */
export function runningAgentTargets(
    terminals: readonly TerminalRecord[],
    sessionId: string,
): TerminalRecord[] {
    return terminals.filter(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            terminal.processId !== undefined &&
            terminal.lastProcessState === 'running' &&
            terminal.lastAgentProcessState === 'running',
    );
}

export function chooseBugReportTarget(
    terminals: readonly TerminalRecord[],
    sessionId: string,
    activeResource: PaneResource | undefined,
): string | undefined {
    const targets = runningAgentTargets(terminals, sessionId);
    const activeTerminalId =
        activeResource?.kind === 'terminal' ? activeResource.terminalId : undefined;
    return targets.find((terminal) => terminal.id === activeTerminalId)?.id ?? targets[0]?.id;
}

/**
 * Explains how the screenshot actually reaches the Agent. Every provider now gets the file path in the report text, so
 * the notice always promises that much; only a provider with a Caxri-safe image input adds the clipboard-paste
 * sentence, because that path has a side effect (it overwrites the user's clipboard) they should know about first.
 */
export function bugReportImageDeliveryNotice(t: Translate, provider?: AgentProvider): string {
    if (provider && agentProviderCatalog[provider].imageInput)
        return t('bugReport.imageDelivery.pasted');
    return t('bugReport.imageDelivery.savedPath');
}
