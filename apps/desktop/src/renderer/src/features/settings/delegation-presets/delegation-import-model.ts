import type { AgentProvider, DelegationImportIssue, MethodResult } from '@caxri/protocol';
import {
    agentProviderCatalog,
    delegationImportErrorDetailsSchema,
    isCaxriError,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';

export type DelegationImportPreview = MethodResult<'settings.delegation.import'>;

/**
 * The three numbers of the preview headline. Presets only: a caller or depth change has its own line.
 */
export function importCounts(diff: DelegationImportPreview['diff']) {
    return {
        added: diff.presets.added.length,
        changed: diff.presets.changed.length,
        removed: diff.presets.removed.length,
    };
}

/**
 * `review: model, effort`: which fields of a preset the import rewrites. Field names are protocol identifiers, shown as
 * they are written in the settings file.
 */
export function changedPresetLines(diff: DelegationImportPreview['diff']): string[] {
    return diff.presets.changed.map(({ name, fields }) => `${name}: ${fields.join(', ')}`);
}

function providerName(provider: AgentProvider): string {
    return agentProviderCatalog[provider].displayName;
}

/**
 * The caller-rule and depth changes the preset counts leave out, one sentence each, so nothing the import changes is
 * invisible before the user confirms.
 */
export function otherChangeLines(preview: DelegationImportPreview, t: Translate): string[] {
    const { callers, settings } = preview.diff;
    const lines: string[] = [];
    if (callers.added.length > 0)
        lines.push(
            t('settings.delegationPresets.callersAdded', {
                providers: callers.added.map(providerName).join(', '),
            }),
        );
    if (callers.changed.length > 0)
        lines.push(
            t('settings.delegationPresets.callersChanged', {
                providers: callers.changed
                    .map(
                        ({ provider, fields }) =>
                            `${providerName(provider)} (${fields.join(', ')})`,
                    )
                    .join(', '),
            }),
        );
    if (callers.removed.length > 0)
        lines.push(
            t('settings.delegationPresets.callersRemoved', {
                providers: callers.removed.map(providerName).join(', '),
            }),
        );
    if (settings.includes('maxDepth'))
        lines.push(t('settings.delegationPresets.depthChanged', { depth: preview.maxDepth }));
    return lines;
}

/**
 * The value-free issues of a rejected import, or an empty list for any other failure.
 */
export function importIssues(error: unknown): DelegationImportIssue[] {
    if (!isCaxriError(error) || error.code !== 'VALIDATION') return [];
    const details = delegationImportErrorDetailsSchema.safeParse(error.details);
    return details.success ? details.data.issues : [];
}

/**
 * Whether the Server refused an apply because the settings changed after the preview was computed.
 */
export function isStalePreview(error: unknown): boolean {
    return (
        isCaxriError(error) &&
        error.code === 'CONFLICT' &&
        error.details?.reason === 'stale_preview'
    );
}

/**
 * One localized line per issue: where (the sanitized path), then why. The wording comes from the closed reason set and
 * the position from the Server, so a line never carries text from the file.
 */
export function importIssueLines(issues: readonly DelegationImportIssue[], t: Translate): string[] {
    return issues.map((issue) => {
        const reason = t(`settings.delegationPresets.issue.${issue.reason}`);
        const where = issue.path || t('settings.delegationPresets.issue.file');
        const position =
            issue.line === undefined
                ? ''
                : ` ${t('settings.delegationPresets.issue.position', { line: issue.line, column: issue.column ?? 1 })}`;
        const line = `${where}: ${reason}${position}`;
        return issue.stage === 'result'
            ? `${t('settings.delegationPresets.afterMerge')} ${line}`
            : line;
    });
}
