import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import { join } from 'node:path';

import type { MessageBoxOptions } from 'electron';
import { z } from 'zod';

const FIXTURE_ID = 'session-pr-open-parity-v1';
const FIXTURE_URL = 'https://github.com/tjx666/project/pull/42';
const commandSchema = z.strictObject({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(['confirm-success', 'cancel', 'confirm-reject']),
});

/**
 * Replaces only native external-link I/O for one fixed Acceptance case. It never grants Main evaluation, arbitrary
 * URLs, browser launches, or trusted-domain writes.
 */
export function createAcceptanceExternalOpenFixture(options: {
    environment: NodeJS.ProcessEnv;
    userDataPath: string;
}) {
    if (
        options.environment.CAXRI_ACCEPTANCE !== '1' ||
        options.environment.CAXRI_E2E !== '1' ||
        options.environment.CAXRI_ACCEPTANCE_EXTERNAL_OPEN !== FIXTURE_ID
    )
        return;

    const commandPath = join(options.userDataPath, 'acceptance-external-open-command.json');
    const receiptPath = join(options.userDataPath, 'acceptance-external-open-receipt.jsonl');
    let lastSequence = 0;
    let pending: z.infer<typeof commandSchema> | undefined;
    let isPrompting = false;
    const record = (value: Record<string, unknown>) =>
        appendFile(receiptPath, `${JSON.stringify(value)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag:
                constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        });
    const assertUrl = (url: string) => {
        if (url !== FIXTURE_URL) throw new Error('Unexpected Acceptance external URL');
    };

    return {
        async prompt(url: URL, prompt: MessageBoxOptions): Promise<{ response: number }> {
            assertUrl(url.href);
            if (isPrompting || pending)
                throw new Error('Acceptance external open is already pending');
            isPrompting = true;
            try {
                const file = await open(
                    commandPath,
                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                );
                let command: z.infer<typeof commandSchema>;
                try {
                    const metadata = await file.stat();
                    if (!metadata.isFile() || metadata.size > 4096)
                        throw new Error('Invalid Acceptance external command file');
                    const buffer = Buffer.alloc(4097);
                    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
                    if (bytesRead > 4096)
                        throw new Error('Acceptance external command is too large');
                    command = commandSchema.parse(
                        JSON.parse(buffer.toString('utf8', 0, bytesRead)),
                    );
                } finally {
                    await file.close();
                }
                if (command.sequence <= lastSequence)
                    throw new Error('Acceptance external command was already consumed');
                lastSequence = command.sequence;
                await record({
                    kind: 'confirmation',
                    sequence: command.sequence,
                    decision: command.decision,
                    url: FIXTURE_URL,
                    message: prompt.message,
                    detail: prompt.detail,
                    buttons: prompt.buttons,
                });
                if (command.decision === 'cancel') return { response: prompt.cancelId ?? 2 };
                pending = command;
                return { response: 0 };
            } finally {
                isPrompting = false;
            }
        },
        async open(url: string): Promise<void> {
            assertUrl(url);
            const command = pending;
            if (!command) throw new Error('Acceptance external open requires a fresh confirmation');
            pending = undefined;
            const outcome = command.decision === 'confirm-reject' ? 'rejected' : 'resolved';
            await record({ kind: 'open', sequence: command.sequence, url: FIXTURE_URL, outcome });
            if (outcome === 'rejected') throw new Error('Acceptance external browser rejection');
        },
    };
}
