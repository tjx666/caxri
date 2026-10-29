import type { AgentTimelineItem, AgentTimelineTurnOutcome } from '@caxri/protocol';
import { MOBILE_TIMELINE_MESSAGE_PREVIEW_LENGTH } from '@caxri/protocol';

import { ownedSlice } from '../owned-string';
import type { SystemEventProjection } from './system-event';
import { stripInjectedTranscriptContent } from './visible-transcript-message';

const MAX_MESSAGE_CHARS = MOBILE_TIMELINE_MESSAGE_PREVIEW_LENGTH;
const MAX_DETAIL_CHARS = 2_048;

interface TimelineEntry {
    item: AgentTimelineItem;
    offset: number;
    part: number;
}

/**
 * Truncates `text` into an owned copy: `AgentTimelineService` holds projected items across reads.
 */
function bounded(text: string, maximum: number): string {
    return text.length <= maximum ? text : ownedSlice(text, 0, maximum);
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function timelineObject(value: unknown): Record<string, unknown> | undefined {
    return object(value);
}

export function timelineTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string') return;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

export function timelineText(value: unknown, maximum = MAX_MESSAGE_CHARS): string | undefined {
    if (typeof value !== 'string') return;
    const text = stripInjectedTranscriptContent(value).trim();
    return text ? bounded(text, maximum) : undefined;
}

export function timelineSummary(value: unknown, fallback: string): string {
    const text = timelineText(value, 240)?.split('\n', 1)[0]?.trim();
    return text ?? fallback;
}

/* eslint-disable unicorn/consistent-class-member-order -- Public projection methods precede the private insertion helper. */
export class TimelineBuilder {
    readonly #keys = new Map<string, number>();
    readonly #calls = new Map<string, string>();
    readonly entries: TimelineEntry[] = [];

    /**
     * `messageLimit` is the most characters a message keeps. The default is the short preview the phone's timeline
     * holds; reading one message in full raises it (`AgentTimelineService.readMessage`).
     */
    constructor(
        readonly generation: string,
        private readonly messageLimit = MAX_MESSAGE_CHARS,
    ) {}

    #id(offset: number, part: number): string {
        return `${this.generation}:${offset.toString(36)}:${part.toString(36)}`;
    }

    addMessage(
        role: 'user' | 'assistant',
        text: string,
        offset: number,
        part: number,
        key?: string,
        timestamp?: number,
    ): void {
        const type = role === 'user' ? 'userMessage' : 'agentMessage';
        const message = bounded(text, this.messageLimit);
        if (!message) return;
        const existing = key ? this.#keys.get(`message:${key}`) : undefined;
        if (existing !== undefined) {
            const entry = this.entries[existing];
            if (entry.item.type !== type) return;
            const previous = entry.item.text;
            const next = message.startsWith(previous)
                ? message
                : previous.endsWith(message)
                  ? previous
                  : bounded(`${previous}${message}`, this.messageLimit);
            entry.item = { ...entry.item, text: next };
            return;
        }
        this.#add(
            { id: this.#id(offset, part), type, text: message, ...(timestamp && { timestamp }) },
            offset,
            part,
            key && `message:${key}`,
        );
    }

    addTool(
        callId: string | undefined,
        name: string,
        summary: string,
        offset: number,
        part: number,
        timestamp?: number,
        detail?: string,
    ): void {
        const key = callId && `tool:${callId}`;
        if (key && this.#keys.has(key)) return;
        const id = this.#id(offset, part);
        this.#add(
            {
                id,
                type: 'toolCall',
                name: bounded(name, 100),
                summary: bounded(summary, 240),
                status: 'running',
                ...(timestamp && { timestamp }),
                ...(detail && { detail: bounded(detail, MAX_DETAIL_CHARS) }),
            },
            offset,
            part,
            key,
        );
        if (callId) this.#calls.set(callId, id);
    }

    finishTool(
        callId: string | undefined,
        isFailed: boolean,
        timestamp?: number,
        detail?: string,
    ): void {
        if (!callId) return;
        const id = this.#calls.get(callId);
        if (!id) return;
        const index = this.#keys.get(`tool:${callId}`);
        const entry = index === undefined ? undefined : this.entries[index];
        if (entry?.item.type !== 'toolCall') return;
        const durationMs =
            timestamp !== undefined && entry.item.timestamp !== undefined
                ? Math.max(0, timestamp - entry.item.timestamp)
                : undefined;
        entry.item = {
            ...entry.item,
            status: isFailed ? 'failed' : 'succeeded',
            ...(durationMs !== undefined && { durationMs }),
            ...(detail && { detail: bounded(detail, MAX_DETAIL_CHARS) }),
        };
    }

    /**
     * A harness-injected system event is a one-shot projection of a single transcript line, never a streamed chunk, so
     * unlike `addMessage` it needs no key-based accumulation.
     */
    addSystemEvent(
        { detail, kind, status, summary }: SystemEventProjection,
        offset: number,
        part: number,
        timestamp?: number,
    ): void {
        this.#add(
            {
                id: this.#id(offset, part),
                type: 'systemEvent',
                kind,
                summary: bounded(summary, 240),
                ...(status && { status }),
                ...(timestamp && { timestamp }),
                ...(detail && { detail: bounded(detail, MAX_DETAIL_CHARS) }),
            },
            offset,
            part,
        );
    }

    /**
     * Ends a turn. `outcome` is set only when the record says how the turn ended; a bare boundary reads as completed.
     */
    addBoundary(
        offset: number,
        part: number,
        durationMs?: number,
        timestamp?: number,
        outcome?: AgentTimelineTurnOutcome,
    ): void {
        this.#add(
            {
                id: this.#id(offset, part),
                type: 'turnBoundary',
                ...(durationMs !== undefined && { durationMs }),
                ...(outcome && { outcome }),
                ...(timestamp && { timestamp }),
            },
            offset,
            part,
        );
    }

    #add(item: AgentTimelineItem, offset: number, part: number, key?: string): void {
        if (key && this.#keys.has(key)) return;
        const index = this.entries.length;
        this.entries.push({ item, offset, part });
        if (key) this.#keys.set(key, index);
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
