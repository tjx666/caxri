import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { appendAcceptanceReceipt, readAcceptanceCommand } from './acceptance-fixtures/fixture-io';

/**
 * Mirrors the Acceptance report's case-id contract (`.agents/skills/acceptance/scripts/runtime-state.ts`), which Main
 * cannot import. A value outside it was never produced by the launcher from a frozen plan.
 */
const ACCEPTANCE_CASE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/u;

export type AcceptanceThemeImportAdmission =
    | { kind: 'fixture'; caseId: string }
    | { kind: 'native' }
    | { kind: 'rejected'; reason: 'invalid-case-id' | 'missing-gate' | 'undeclared-case' };

/**
 * Decides who answers **Import Theme** in this Main process. Outside Acceptance the real open panel stays in charge.
 * Inside Acceptance the launcher arms `CAXRI_ACCEPTANCE_THEME_IMPORT` only for a case whose frozen plan declares
 * `themeImportFixture: true`, so an unarmed Acceptance launch must fail visibly instead of degrading into a real macOS
 * open panel, a manual boundary an agent may not drive. The single exception is `CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT`,
 * which the launcher derives only when the frozen plan declares `themeImportFixture: false` and the launch carries the
 * explicit native-dialog authorization; the raw authorization marker alone never opens the panel, so a stale marker in
 * a shell cannot re-open this boundary for an undeclared case.
 */
export function admitAcceptanceThemeImport(
    environment: NodeJS.ProcessEnv,
): AcceptanceThemeImportAdmission {
    if (environment.CAXRI_ACCEPTANCE !== '1') return { kind: 'native' };
    const caseId = environment.CAXRI_ACCEPTANCE_THEME_IMPORT;
    if (caseId === undefined)
        return environment.CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT === '1'
            ? { kind: 'native' }
            : { kind: 'rejected', reason: 'undeclared-case' };
    if (!ACCEPTANCE_CASE_ID_PATTERN.test(caseId))
        return { kind: 'rejected', reason: 'invalid-case-id' };
    if (environment.CAXRI_E2E !== '1' || !environment.CAXRI_TEST_ROOT_PATH)
        return { kind: 'rejected', reason: 'missing-gate' };
    return { kind: 'fixture', caseId };
}

const rejectionMessages: Record<
    Extract<AcceptanceThemeImportAdmission, { kind: 'rejected' }>['reason'],
    string
> = {
    'invalid-case-id': 'The Acceptance theme import case id is malformed.',
    'missing-gate': 'The Acceptance theme import fixture requires the E2E and test-root gates.',
    'undeclared-case':
        'This Acceptance case did not declare themeImportFixture, so Import Theme cannot open the native panel.',
};

const commandSchema = z.strictObject({
    caseId: z.string(),
    relativePath: z.string().min(1).max(512),
    sequence: z.number().int().positive(),
});

/**
 * Supplies only the native file picker's result for a theme Acceptance case whose frozen plan declared
 * `themeImportFixture`. The real Main handler, Server import, Renderer warning flow, and persistence remain in the path
 * under test. A rejected admission returns a chooser that always fails, so the Renderer shows an import error rather
 * than Main falling through to the real panel.
 */
export function createAcceptanceThemeImportFixture(options: {
    environment: NodeJS.ProcessEnv;
    userDataPath: string;
}): { choose(): Promise<string> } | undefined {
    const { environment, userDataPath } = options;
    const admission = admitAcceptanceThemeImport(environment);
    if (admission.kind === 'native') return;
    if (admission.kind === 'rejected') {
        const message = rejectionMessages[admission.reason];
        return { choose: () => Promise.reject(new Error(message)) };
    }
    const { caseId } = admission;

    const commandPath = join(userDataPath, 'acceptance-theme-import-command.json');
    const receiptPath = join(userDataPath, 'acceptance-theme-import-receipt.jsonl');
    let lastSequence = 0;

    return {
        async choose(): Promise<string> {
            const command = await readAcceptanceCommand(commandPath, commandSchema);
            if (command.caseId !== caseId || command.sequence <= lastSequence)
                throw new Error('Acceptance theme import command does not match this launch');
            if (isAbsolute(command.relativePath))
                throw new Error('Acceptance theme import path must be relative');
            const root = await realpath(environment.CAXRI_TEST_ROOT_PATH!);
            const selected = resolve(root, command.relativePath);
            const within = relative(root, selected);
            if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
                throw new Error('Acceptance theme import path escapes the test root');
            const metadata = await lstat(selected);
            if (!metadata.isFile()) throw new Error('Acceptance theme import path is not a file');
            const canonical = await realpath(selected);
            const canonicalWithin = relative(root, canonical);
            if (
                canonicalWithin === '..' ||
                canonicalWithin.startsWith(`..${sep}`) ||
                isAbsolute(canonicalWithin)
            )
                throw new Error('Acceptance theme import path resolves outside the test root');
            lastSequence = command.sequence;
            await appendAcceptanceReceipt(receiptPath, {
                caseId,
                relativePath: within,
                sequence: command.sequence,
            });
            return canonical;
        },
    };
}
