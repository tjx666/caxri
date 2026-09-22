import type { SessionContentSearchResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { waitForSharedOperation } from '@caxri/system';

import type { CaxriDatabase } from '../../db';
import type { AgentEnvironment } from '../contract';
import { locateAgentTranscript } from '../transcript';
import { contentMatchSnippet } from './matching';
import { TranscriptSearchReader } from './reader';

interface SearchLimits {
    timeoutMs: number;
    sessions: number;
    bytes: number;
    fileBytes: number;
    matches: number;
}
const DEFAULT_LIMITS: SearchLimits = {
    timeoutMs: 5000,
    sessions: 200,
    bytes: 16 * 1024 * 1024,
    fileBytes: 4 * 1024 * 1024,
    matches: 100,
};

/**
 * Owner-only on-demand search. Canceled callers stop waiting immediately; uncancellable filesystem work retains its
 * actual slot until it settles, so repeated queries cannot accumulate background transcript locators or open handles.
 */
export class SessionContentSearch {
    private active = 0;
    private readonly reader = new TranscriptSearchReader();
    private readonly limits: SearchLimits;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly environment: AgentEnvironment,
        limits: Partial<SearchLimits> = {},
    ) {
        this.limits = { ...DEFAULT_LIMITS, ...limits };
    }

    private async scan(
        sessions: ReturnType<CaxriDatabase['listSessions']>,
        query: string,
        result: SessionContentSearchResult,
        signal: AbortSignal,
    ): Promise<void> {
        let bytes = 0;
        /* eslint-disable no-await-in-loop -- one transcript at a time preserves the per-request IO and byte budget */
        for (let index = 0; index < sessions.length; index += 1) {
            signal.throwIfAborted();
            if (index >= this.limits.sessions || bytes >= this.limits.bytes) {
                result.partial = true;
                result.reason = 'budget';
                break;
            }
            const session = sessions[index];
            const terminal = session.primaryAgentTerminalId
                ? this.database.getTerminal(session.primaryAgentTerminalId)
                : undefined;
            if (
                !terminal?.provider ||
                !terminal.agentSessionId ||
                !['claude', 'codex', 'grok'].includes(terminal.provider)
            ) {
                result.unavailable += 1;
                continue;
            }
            try {
                const location = await locateAgentTranscript(
                    this.database,
                    terminal.id,
                    this.environment,
                    signal,
                );
                signal.throwIfAborted();
                const transcript =
                    location &&
                    (await this.reader.read(
                        location,
                        Math.min(this.limits.fileBytes, this.limits.bytes - bytes),
                        signal,
                    ));
                signal.throwIfAborted();
                const current = this.database.getTerminal(terminal.id);
                if (
                    !transcript ||
                    current?.sessionId !== session.id ||
                    current.agentSessionId !== terminal.agentSessionId ||
                    current.provider !== terminal.provider
                ) {
                    result.unavailable += 1;
                    continue;
                }
                bytes += transcript.bytesRead;
                result.scanned += 1;
                result.partial ||= transcript.partial;
                const snippet = contentMatchSnippet(transcript.text, query);
                if (snippet !== undefined)
                    result.matches.push({
                        sessionId: session.id,
                        provider: terminal.provider,
                        snippet,
                    });
                if (result.matches.length >= this.limits.matches && index + 1 < sessions.length) {
                    result.partial = true;
                    result.reason = 'results';
                    break;
                }
            } catch (error) {
                if (signal.aborted) throw error;
                result.unavailable += 1;
            }
        }
        /* eslint-enable no-await-in-loop */
        result.partial ||= result.unavailable > 0;
        if (result.partial && result.reason === 'complete') result.reason = 'coverage';
    }

    private async runScan(
        sessions: ReturnType<CaxriDatabase['listSessions']>,
        query: string,
        result: SessionContentSearchResult,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            await this.scan(sessions, query, result, signal);
        } finally {
            this.active -= 1;
        }
    }

    async search(query: string, signal?: AbortSignal): Promise<SessionContentSearchResult> {
        signal?.throwIfAborted();
        const sessions = this.database.listSessions();
        const result: SessionContentSearchResult = {
            matches: [],
            scanned: 0,
            total: sessions.length,
            unavailable: 0,
            partial: false,
            reason: 'complete',
        };
        if (this.active >= 2) return { ...result, partial: true, reason: 'budget' };
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), this.limits.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
        this.active += 1;
        const operation = this.runScan(sessions, query, result, combined);
        try {
            await waitForSharedOperation(
                operation,
                combined,
                () => new CaxriError('CANCELLED', 'Session search canceled'),
            );
            return result;
        } catch (error) {
            if (signal?.aborted) throw new CaxriError('CANCELLED', 'Session search canceled');
            if (!deadline.signal.aborted) throw error;
            return { ...result, matches: [...result.matches], partial: true, reason: 'budget' };
        } finally {
            clearTimeout(timer);
        }
    }
}
