import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { appendFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { MessageBoxOptions } from 'electron';
import { z } from 'zod';

/**
 * The Acceptance cases allowed to answer the Session deletion confirmation without a real macOS sheet, and the only
 * place that list lives. The launcher imports it to decide whether to pass `CAXRI_ACCEPTANCE_SESSION_DELETE`; a second
 * copy there would silently degrade an unlisted case into a manual boundary instead of a visible failure.
 */
export const acceptanceSessionDeleteCaseIds: ReadonlySet<string> = new Set(['audit-naming-cancel']);

const commandSchema = z.strictObject({
    caseId: z.string(),
    decision: z.enum(['confirm', 'cancel']),
    sequence: z.number().int().positive(),
    sessionId: z.string().min(1).max(200),
});

/**
 * Supplies only the native confirmation's answer for the fixed Session deletion Acceptance cases. Each deletion needs
 * its own freshly written command file naming the exact Session and carrying a higher sequence, so an armed launch can
 * neither confirm a second deletion nor confirm a different Session than the case asked for. Reading the command also
 * consumes it, on the rejected paths too, so a reused `restart` profile cannot replay a leftover against the next
 * launch's fresh in-memory sequence. The Renderer command, Main authorization, and the Server deletion itself all stay
 * in the path under test.
 *
 * The receipt records the opaque Session id but no prompt text: the confirmation names the Session, and Session names
 * are private Acceptance material while the local id is not.
 */
export function createAcceptanceSessionDeleteFixture(options: {
    environment: NodeJS.ProcessEnv;
    userDataPath: string;
}) {
    const { environment, userDataPath } = options;
    const caseId = environment.CAXRI_ACCEPTANCE_SESSION_DELETE;
    if (
        !caseId ||
        !acceptanceSessionDeleteCaseIds.has(caseId) ||
        environment.CAXRI_ACCEPTANCE !== '1' ||
        environment.CAXRI_E2E !== '1'
    )
        return;

    const commandPath = join(userDataPath, 'acceptance-session-delete-command.json');
    const receiptPath = join(userDataPath, 'acceptance-session-delete-receipt.jsonl');
    let lastSequence = 0;

    return {
        async confirm(sessionId: string, prompt: MessageBoxOptions): Promise<{ response: number }> {
            const handle = await open(
                commandPath,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            let command: z.infer<typeof commandSchema>;
            try {
                const metadata = await handle.stat();
                if (!metadata.isFile() || metadata.size > 4096)
                    throw new Error('Invalid Acceptance session delete command file');
                const buffer = Buffer.alloc(4097);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead > 4096)
                    throw new Error('Acceptance session delete command is too large');
                command = commandSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
            } finally {
                await handle.close();
                await rm(commandPath, { force: true });
            }
            if (
                command.caseId !== caseId ||
                command.sessionId !== sessionId ||
                command.sequence <= lastSequence
            )
                throw new Error('Acceptance session delete command does not match this deletion');
            lastSequence = command.sequence;
            await appendFile(
                receiptPath,
                `${JSON.stringify({
                    buttons: prompt.buttons,
                    caseId,
                    decision: command.decision,
                    sequence: command.sequence,
                    sessionId,
                })}\n`,
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
            if (command.decision === 'cancel')
                return { response: prompt.cancelId ?? (prompt.buttons?.length ?? 2) - 1 };
            return { response: 0 };
        },
    };
}
