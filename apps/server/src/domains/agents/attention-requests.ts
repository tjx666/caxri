import { randomUUID } from 'node:crypto';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

type AttentionRequest = MethodResult<'mobile.attention.list'>['requests'][number];
interface AttentionAnswer {
    decision?: 'allow' | 'deny';
    answers?: Record<string, string>;
}
const REQUEST_LIFETIME_MS = 120_000;

interface PendingRequest {
    request: AttentionRequest;
    launchId: string;
    settle: (result: { requestId: string; answer: AttentionAnswer | null }) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Each blocking hook instance owns one answer promise. A request ID never maps to terminal keystrokes.
 */
export class AgentAttentionRequests {
    readonly #requests = new Map<string, PendingRequest>();

    #finish(id: string, status: AttentionRequest['status'], answer: AttentionAnswer | null): void {
        const entry = this.#requests.get(id);
        if (entry?.request.status !== 'pending') return;
        clearTimeout(entry.timer);
        entry.request = { ...entry.request, status };
        entry.settle({ requestId: id, answer });
        const removal = setTimeout(() => this.#requests.delete(id), 5 * 60_000);
        removal.unref();
    }

    list(sessionId: string): AttentionRequest[] {
        return this.#requests
            .values()
            .filter((entry) => entry.request.sessionId === sessionId)
            .map((entry) => entry.request)
            .toArray()
            .slice(-20);
    }

    offer(
        input: Omit<AttentionRequest, 'id' | 'status' | 'expiresAt'> & {
            launchId: string;
            signal?: AbortSignal;
        },
    ): Promise<{ requestId: string; answer: AttentionAnswer | null }> {
        const id = randomUUID();
        const expiresAt = Date.now() + REQUEST_LIFETIME_MS;
        return new Promise((resolve) => {
            const request: AttentionRequest = {
                id,
                sessionId: input.sessionId,
                terminalId: input.terminalId,
                kind: input.kind,
                status: 'pending',
                toolName: input.toolName,
                summary: input.summary,
                questions: input.questions,
                expiresAt,
            };
            const timer = setTimeout(() => this.#finish(id, 'expired', null), REQUEST_LIFETIME_MS);
            timer.unref();
            this.#requests.set(id, { request, launchId: input.launchId, settle: resolve, timer });
            input.signal?.addEventListener('abort', () => this.#finish(id, 'superseded', null), {
                once: true,
            });
            if (input.signal?.aborted) this.#finish(id, 'superseded', null);
        });
    }

    answer(
        sessionId: string,
        requestId: string,
        answer: AttentionAnswer,
    ): { status: AttentionRequest['status'] } {
        const entry = this.#requests.get(requestId);
        if (!entry || entry.request.sessionId !== sessionId)
            throw new CaxriError('NOT_FOUND', 'Attention request not found');
        if (entry.request.status !== 'pending')
            throw new CaxriError('CONFLICT', 'Attention request is no longer pending');
        if (entry.request.kind === 'permission') {
            if (!answer.decision || answer.answers)
                throw new CaxriError('VALIDATION', 'A permission decision is required');
        } else {
            if (answer.decision || !answer.answers)
                throw new CaxriError('VALIDATION', 'Question answers are required');
            const questions = entry.request.questions;
            if (
                Object.keys(answer.answers).length !== questions.length ||
                questions.some((question) => !answer.answers?.[question.question]?.trim())
            )
                throw new CaxriError('VALIDATION', 'Every question needs an answer');
        }
        this.#finish(requestId, 'answered', answer);
        return { status: 'answered' };
    }

    markApplied(requestId: string): void {
        const entry = this.#requests.get(requestId);
        if (entry?.request.status === 'answered')
            entry.request = { ...entry.request, status: 'applied' };
    }

    supersedeLaunch(terminalId: string, launchId: string): void {
        for (const [id, entry] of this.#requests) {
            if (entry.request.terminalId === terminalId && entry.launchId === launchId)
                this.#finish(id, 'superseded', null);
        }
    }

    supersedeTerminal(terminalId: string): void {
        for (const [id, entry] of this.#requests) {
            if (entry.request.terminalId === terminalId) this.#finish(id, 'superseded', null);
        }
    }
}
