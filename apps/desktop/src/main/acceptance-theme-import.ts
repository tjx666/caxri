import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { appendFile, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

/**
 * The Acceptance cases allowed to replace the native file picker, and the only place that list lives. The launcher
 * imports it to decide whether to pass `CAXRI_ACCEPTANCE_THEME_IMPORT`; a second copy there silently degrades an
 * unlisted case into a real macOS open panel, which is a manual boundary rather than a visible failure.
 */
export const acceptanceThemeImportCaseIds: ReadonlySet<string> = new Set([
    'issue-826-surface-seam',
    'issue-824-syntax-and-terminal-selection',
    'issue-825-include-zero-hit-vsix',
    'issue-851-transient-warnings',
    'issue-854-contrast-error',
    'theme-roles-follow-import',
    'theme-import-validation-error',
]);
const commandSchema = z.strictObject({
    caseId: z.string(),
    relativePath: z.string().min(1).max(512),
    sequence: z.number().int().positive(),
});

/**
 * Supplies only the native file picker's result for the fixed theme Acceptance cases. The real Main handler, Server
 * import, Renderer warning flow, and persistence remain in the path under test.
 */
export function createAcceptanceThemeImportFixture(options: {
    environment: NodeJS.ProcessEnv;
    userDataPath: string;
}) {
    const { environment, userDataPath } = options;
    const caseId = environment.CAXRI_ACCEPTANCE_THEME_IMPORT;
    if (
        !caseId ||
        !acceptanceThemeImportCaseIds.has(caseId) ||
        !environment.CAXRI_TEST_ROOT_PATH ||
        environment.CAXRI_ACCEPTANCE !== '1' ||
        environment.CAXRI_E2E !== '1'
    )
        return;

    const commandPath = join(userDataPath, 'acceptance-theme-import-command.json');
    const receiptPath = join(userDataPath, 'acceptance-theme-import-receipt.jsonl');
    let lastSequence = 0;

    return {
        async choose(): Promise<string> {
            const handle = await open(
                commandPath,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            let command: z.infer<typeof commandSchema>;
            try {
                const metadata = await handle.stat();
                if (!metadata.isFile() || metadata.size > 4096)
                    throw new Error('Invalid Acceptance theme import command file');
                const buffer = Buffer.alloc(4097);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead > 4096)
                    throw new Error('Acceptance theme import command is too large');
                command = commandSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
            } finally {
                await handle.close();
            }
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
            await appendFile(
                receiptPath,
                `${JSON.stringify({ caseId, relativePath: within, sequence: command.sequence })}\n`,
                {
                    encoding: 'utf8',
                    mode: 0o600,
                    flag:
                        constants.O_CREAT |
                        constants.O_APPEND |
                        constants.O_WRONLY |
                        constants.O_NOFOLLOW,
                },
            );
            return canonical;
        },
    };
}
