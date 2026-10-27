import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { getuid } from 'node:process';

import type { AgentProvider, SessionConversationReference } from '@caxri/protocol';
import {
    agentProviderCatalog,
    CaxriError,
    MAX_SESSION_CONVERSATION_REFERENCE_BYTES,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, logEventCatalog } from '@caxri/system';

import type {
    AgentEnvironment,
    TranscriptConversationMessage,
    TranscriptScanFailureReason,
} from '../agents';
import {
    defaultAgentEnvironment,
    locateAgentTranscript,
    readTranscriptConversation,
} from '../agents';
import type { CaxriDatabase } from '../db';
import type { OwnedFileRetention } from '../owned-file-retention';
import { ownedFileTimestamp, pruneOwnedFiles } from '../owned-file-retention';

/**
 * The per-user temporary directory rather than the profile: a profile path such as `~/Library/Application Support/…`
 * carries a space, and an `@` mention ends at the first space in every Agent composer.
 */
export function defaultSessionReferenceDirectory(): string {
    // Scoped by uid so another account on a shared `/tmp` (Linux) cannot squat the name and block references.
    return join(tmpdir(), `caxri-session-references-${userInfo().uid}`);
}
const REFERENCE_FILE_NAME = /^session-\d{8}T\d{6}-[\da-f-]{36}\.md$/u;
/**
 * A reference is read by the Agent within the turn that cites it, or within a resumed conversation soon after. A week
 * covers a long weekend's resume; the byte cap bounds a burst of references well before retention does.
 */
const REFERENCE_RETENTION: OwnedFileRetention = {
    fileName: REFERENCE_FILE_NAME,
    maxBytes: 64 * 1024 * 1024,
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
};
/**
 * The reader retains a little more text than the file holds so the formatter, not the reader, decides the exact cut at
 * a message boundary.
 */
const MAX_RETAINED_CHARS = MAX_SESSION_CONVERSATION_REFERENCE_BYTES;

/**
 * Closed reasons a reference could not be prepared, for `session_context.reference_failed`.
 */
type ReferenceFailureReason = 'empty' | 'noAgent' | 'sessionMissing' | 'transcriptMissing';

interface ConversationMarkdownInput {
    isTailOnly?: boolean;
    messages: readonly TranscriptConversationMessage[];
    omittedMessageCount: number;
    provider: AgentProvider | undefined;
    title: string;
}

interface ConversationMarkdown {
    markdown: string;
    messageCount: number;
    omittedMessageCount: number;
}

function roleHeading(role: TranscriptConversationMessage['role'], agentName: string): string {
    return role === 'user' ? '## User' : `## Agent (${agentName})`;
}

function omissionNote(count: number): string {
    return `> ${count} earlier ${count === 1 ? 'message was' : 'messages were'} omitted to keep this file small.`;
}

/**
 * Renders the condensed conversation, keeping whole messages from the most recent backwards until the UTF-8 byte budget
 * is spent. The header says what was left out so the citing Agent never mistakes the file for the full record.
 */
export function formatConversationMarkdown(
    input: ConversationMarkdownInput,
    maxBytes: number = MAX_SESSION_CONVERSATION_REFERENCE_BYTES,
): ConversationMarkdown {
    const agentName = input.provider ? agentProviderCatalog[input.provider].displayName : 'Agent';
    const header = [
        `# Conversation from Session ${JSON.stringify(input.title)}`,
        '',
        `Condensed by Caxri from the Session's ${agentName} transcript. It keeps only what the user and the Agent wrote; tool calls, tool output, and injected instructions are omitted.`,
        ...(input.isTailOnly
            ? ['', '> The transcript is long, so only its most recent part was read.']
            : []),
    ].join('\n');
    const encoder = new TextEncoder();
    // Reserve room for the widest omission note so adding it never pushes the file over the budget.
    let remaining =
        maxBytes -
        encoder.encode(header).byteLength -
        encoder.encode(`\n\n${omissionNote(Number.MAX_SAFE_INTEGER)}`).byteLength;
    const kept: string[] = [];
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
        const message = input.messages[index];
        const section = `\n\n${roleHeading(message.role, agentName)}\n\n${message.text}`;
        const bytes = encoder.encode(section).byteLength;
        if (bytes > remaining) break;
        remaining -= bytes;
        kept.push(section);
    }
    const omittedMessageCount = input.omittedMessageCount + input.messages.length - kept.length;
    const note = omittedMessageCount > 0 ? `\n\n${omissionNote(omittedMessageCount)}` : '';
    return {
        markdown: `${header}${note}${kept.toReversed().join('')}\n`,
        messageCount: kept.length,
        omittedMessageCount,
    };
}

/**
 * Prepares `@` references to another Session's conversation. The Server reads the target Session's native Agent
 * transcript, condenses it to user and Agent text, and writes it to a Caxri-owned temporary directory; the Renderer
 * receives only the path. Files live in an owner-only temporary directory and expire after a week (or sooner under its
 * byte cap). Conversation text never enters logs, SQLite, or the reply.
 */
export class SessionConversationReferenceService {
    private readonly mutations = new AsyncSemaphore(1);

    constructor(
        private readonly directory: string,
        private readonly database: CaxriDatabase,
        private readonly logger: StructuredLogger,
        private readonly environment: AgentEnvironment = defaultAgentEnvironment(),
        private readonly now: () => number = Date.now,
        private readonly identifier: () => string = randomUUID,
    ) {}

    /**
     * The temporary root can be shared with other accounts (`/tmp` on Linux), so the directory must be a real one this
     * user owns before anything is written into it; a planted symlink would otherwise redirect conversation text.
     */
    private async ensureDirectory(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stats = await lstat(this.directory);
        if (!stats.isDirectory() || stats.isSymbolicLink() || (getuid && stats.uid !== getuid()))
            throw new CaxriError(
                'CONFLICT',
                'The Session reference directory is not owned by you.',
            );
        await chmod(this.directory, 0o700);
    }

    private fail(
        sessionId: string,
        reason: ReferenceFailureReason,
        scanFailure: TranscriptScanFailureReason | undefined,
        error: CaxriError,
    ): never {
        this.logger.write('info', logEventCatalog.sessionContext.referenceFailed, {
            fields: { sessionId, reason, ...(scanFailure && { scanFailure }) },
        });
        throw error;
    }

    async prepare(sessionId: string, signal?: AbortSignal): Promise<SessionConversationReference> {
        const startedAt = performance.now();
        const session = this.database.getSession(sessionId);
        if (!session)
            this.fail(
                sessionId,
                'sessionMissing',
                undefined,
                new CaxriError('NOT_FOUND', 'Session not found'),
            );
        const terminalId = session.primaryAgentTerminalId;
        const terminal = terminalId ? this.database.getTerminal(terminalId) : undefined;
        if (!terminalId || !terminal?.provider)
            this.fail(
                sessionId,
                'noAgent',
                undefined,
                new CaxriError('CONFLICT', 'This Session has no Agent conversation to reference.'),
            );
        const location = await locateAgentTranscript(
            this.database,
            terminalId,
            this.environment,
            signal,
        );
        if (!location)
            this.fail(
                sessionId,
                'transcriptMissing',
                undefined,
                new CaxriError(
                    'NOT_FOUND',
                    "This Session's Agent conversation could not be found.",
                ),
            );
        let scanFailure: TranscriptScanFailureReason | undefined;
        const conversation = await readTranscriptConversation(location, MAX_RETAINED_CHARS, {
            onFailure: (reason) => {
                scanFailure = reason;
            },
            // A cancelled request stops the scan at its next pass instead of reading up to 48 MiB nobody waits for.
            signal,
        });
        signal?.throwIfAborted();
        if (conversation.messages.length === 0)
            this.fail(
                sessionId,
                scanFailure && scanFailure !== 'missing' ? 'transcriptMissing' : 'empty',
                scanFailure,
                new CaxriError('CONFLICT', 'This Session has no messages to reference yet.'),
            );
        const formatted = formatConversationMarkdown({
            messages: conversation.messages,
            omittedMessageCount: conversation.omittedMessageCount,
            isTailOnly: conversation.isTailOnly,
            provider: terminal.provider,
            title: session.title,
        });
        const now = this.now();
        const filePath = join(
            this.directory,
            `session-${ownedFileTimestamp(now)}-${this.identifier()}.md`,
        );
        const bytes = Buffer.byteLength(formatted.markdown, 'utf8');
        await this.mutations.run(async () => {
            await this.ensureDirectory();
            await pruneOwnedFiles(this.directory, REFERENCE_RETENTION, now, bytes);
            await writeFile(filePath, formatted.markdown, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
            await chmod(filePath, 0o600);
        });
        this.logger.write('info', logEventCatalog.sessionContext.referencePrepared, {
            durationMs: Math.round(performance.now() - startedAt),
            fields: {
                sessionId,
                provider: terminal.provider,
                bytes,
                messageCount: formatted.messageCount,
                omittedMessageCount: formatted.omittedMessageCount,
                isTailOnly: conversation.isTailOnly,
            },
        });
        return {
            filePath,
            title: session.title,
            messageCount: formatted.messageCount,
            omittedMessageCount: formatted.omittedMessageCount,
        };
    }
}
