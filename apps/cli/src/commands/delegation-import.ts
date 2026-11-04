import {
    CaxriError,
    delegationImportErrorDetailsSchema,
    formatDelegationImportIssues,
    isCaxriError,
    MAX_CONFIGURATION_SOURCE_BYTES,
} from '@caxri/protocol';

import { readBoundedTextFile } from './text-file';
import type { RemoteCommandDefinition } from './types';

/**
 * The Server parses and merges the file, so the CLI only reads it (bounded) and sends the text.
 */
async function importParameters(tokens: readonly string[]) {
    let path: string | undefined;
    let mode: string | undefined;
    let strategy: 'merge' | 'replace' | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (
            token === '--from' &&
            !path &&
            tokens[index + 1] &&
            !tokens[index + 1].startsWith('--')
        ) {
            path = tokens[index + 1];
            index += 1;
        } else if (!mode && ['--apply', '--dry-run'].includes(token)) mode = token;
        else if (!strategy && ['--merge', '--replace'].includes(token))
            strategy = token === '--replace' ? 'replace' : 'merge';
        else
            throw new CaxriError(
                'VALIDATION',
                'Expected --from <file>, at most one of --merge or --replace, and at most one of --dry-run or --apply',
            );
    }
    if (!path)
        throw new CaxriError('VALIDATION', 'Configuration import requires an explicit --from file');
    return {
        sourceText: await readBoundedTextFile(
            path,
            MAX_CONFIGURATION_SOURCE_BYTES,
            'Configuration import',
        ),
        mode: strategy ?? 'merge',
        dryRun: mode !== '--apply',
    };
}

/**
 * A rejected import carries value-free issues in its details and a fixed message; print the issues.
 */
function describeImportError(error: unknown): Error | undefined {
    if (!isCaxriError(error) || error.code !== 'VALIDATION') return undefined;
    const details = delegationImportErrorDetailsSchema.safeParse(error.details);
    if (!details.success) return undefined;
    return new CaxriError(
        'VALIDATION',
        `Invalid delegation configuration: ${formatDelegationImportIssues(details.data.issues)}`,
        error.details,
    );
}

export const DELEGATION_IMPORT_COMMAND: RemoteCommandDefinition = {
    kind: 'remote',
    path: ['agent', 'delegate', 'import'],
    method: 'settings.delegation.import',
    requiresHumanOwner: true,
    // The request shape changed (the file text replaced converted settings), so an older Server must refuse it.
    requiresServerVersionMatch: true,
    summary: 'Preview or explicitly apply dianjiang presets to this profile.',
    usage: '--from <file> [--merge | --replace] [--dry-run | --apply]',
    confirmation:
        'Import these delegation presets into this profile? --replace also removes presets the file does not list.',
    mutates: (parameters) => (parameters as { dryRun: boolean }).dryRun === false,
    parseParams: importParameters,
    describeError: describeImportError,
};
