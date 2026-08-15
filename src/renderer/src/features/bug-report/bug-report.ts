import type { AgentProvider } from '@shared/agents';
import { agentProviderCatalog } from '@shared/agents';
import { redactSecretText } from '@shared/redaction';
import type { TerminalRecord } from '@shared/types';
import type { WorkItem } from '@shared/work-item';

export interface BugReportDraft {
    actual: string;
    expected: string;
    steps: string;
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

/**
 * Produces the complete payload from an allowlisted context model. There is deliberately no input
 * for editor buffers, Terminal output, Agent state, environment variables, or diagnostics fields.
 */
export function buildBugReport(draft: BugReportDraft, context: BugReportContext): string {
    const errorIds = context.recentErrorIds.map((id) => `  - \`${safeText(id)}\``);
    const visibleWork =
        context.visibleWork.kind === 'editor'
            ? `Editor: ${safeText(context.visibleWork.fileName)}`
            : context.visibleWork.kind === 'terminal'
              ? `${context.visibleWork.provider ? agentProviderCatalog[context.visibleWork.provider].displayName : 'Shell'} Terminal (\`${safeText(context.visibleWork.terminalId)}\`)`
              : 'No active work item';
    return [
        '# Caxri Bug Report',
        '',
        '## Actual behavior',
        safeText(draft.actual),
        '',
        '## Expected behavior',
        safeText(draft.expected),
        '',
        '## Reproduction steps',
        safeText(draft.steps),
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
Live candidates only; the Runtime repeats these checks atomically when the user sends.
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
            terminal.lastProcessState === 'running',
    );
}

export function chooseBugReportTarget(
    terminals: readonly TerminalRecord[],
    sessionId: string,
    activeWork: WorkItem | undefined,
): string | undefined {
    const targets = runningAgentTargets(terminals, sessionId);
    const activeTerminalId = activeWork?.kind === 'terminal' ? activeWork.terminalId : undefined;
    return targets.find((terminal) => terminal.id === activeTerminalId)?.id ?? targets[0]?.id;
}

export function bugReportImageFallback(provider?: AgentProvider): string {
    if (provider && agentProviderCatalog[provider].imageInput)
        return 'The screenshot will be delivered through this Agent image paste. Sending replaces the system clipboard with the captured image.';
    return 'Screenshot capture is preview-only. This Agent has no Caxri-safe automated image attachment; the text report will still be sent.';
}
