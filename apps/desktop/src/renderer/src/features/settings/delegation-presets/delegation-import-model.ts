import type { AgentProvider, DelegationImportIssue, MethodResult } from '@caxri/protocol';
import {
    agentProviderCatalog,
    delegationImportErrorDetailsSchema,
    isCaxriError,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { formatList } from '../../../lib/list-format';

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

type ImportField =
    | DelegationImportPreview['diff']['presets']['changed'][number]['fields'][number]
    | DelegationImportPreview['diff']['callers']['changed'][number]['fields'][number];

/**
 * A changed field in plain words ("model", "when to use"), not the identifier the settings file writes.
 */
function fieldLabel(field: ImportField, t: Translate): string {
    return t(`settings.delegationPresets.field.${field}`);
}

/**
 * The changed fields as one phrase in the interface language ("model and effort").
 */
function fieldList(fields: readonly ImportField[], t: Translate): string {
    const labels = fields.map((field) => fieldLabel(field, t));
    return formatList(labels, t.locale);
}

/**
 * `review: model and effort`: which fields of a preset the import rewrites, named in plain words.
 */
export function changedPresetLines(diff: DelegationImportPreview['diff'], t: Translate): string[] {
    return diff.presets.changed.map(({ name, fields }) => `${name}: ${fieldList(fields, t)}`);
}

/**
 * `Adds: review, audit`: every preset the import adds, or `Removes: ...` for those it removes, by name, so the counts
 * never stand in for which presets change. Empty when there are none.
 */
export function presetNameLines(diff: DelegationImportPreview['diff'], t: Translate): string[] {
    const { added, removed } = diff.presets;
    const lines: string[] = [];
    if (added.length > 0)
        lines.push(t('settings.delegationPresets.added', { names: formatList(added, t.locale) }));
    if (removed.length > 0)
        lines.push(
            t('settings.delegationPresets.removed', { names: formatList(removed, t.locale) }),
        );
    return lines;
}

function providerName(provider: AgentProvider): string {
    return agentProviderCatalog[provider].displayName;
}

function providerList(providers: readonly AgentProvider[], t: Translate): string {
    return formatList(providers.map(providerName), t.locale);
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
                providers: providerList(callers.added, t),
            }),
        );
    if (callers.changed.length > 0) {
        const changed = callers.changed.map(
            ({ provider, fields }) => `${providerName(provider)} (${fieldList(fields, t)})`,
        );
        lines.push(
            t('settings.delegationPresets.callersChanged', {
                providers: formatList(changed, t.locale),
            }),
        );
    }
    if (callers.removed.length > 0)
        lines.push(
            t('settings.delegationPresets.callersRemoved', {
                providers: providerList(callers.removed, t),
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
