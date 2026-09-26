import { classifySystemEvent } from '../../system-event';
import type { TimelineBuilder } from '../../timeline-model';
import {
    timelineObject,
    timelineSummary,
    timelineText,
    timelineTimestamp,
} from '../../timeline-model';
import {
    extractRawUserTranscriptText,
    extractVisibleTranscriptMessage,
} from '../../visible-transcript-message';

function parsedArguments(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'string' || value.length > 16 * 1_024) return;
    try {
        return timelineObject(JSON.parse(value));
    } catch {
        return;
    }
}

function codexToolSummary(name: string, payload: Record<string, unknown>): string {
    const argumentsValue = parsedArguments(payload.arguments);
    return timelineSummary(
        argumentsValue?.command ?? argumentsValue?.cmd ?? argumentsValue?.path ?? payload.input,
        name,
    );
}

/**
 * Codex writes canonical messages and tool calls as response_item records in its rollout JSONL.
 */
export function appendCodexTimelineRecord(
    builder: TimelineBuilder,
    value: unknown,
    offset: number,
): void {
    const record = timelineObject(value);
    if (!record) return;
    const timestamp = timelineTimestamp(record.timestamp);
    const payload = timelineObject(record.payload);
    if (record.type === 'event_msg') {
        if (payload?.type === 'task_complete' || payload?.type === 'turn_aborted')
            builder.addBoundary(offset, 0, undefined, timestamp);
        return;
    }
    if (!payload || record.type !== 'response_item') return;
    if (payload.type === 'message') {
        const rawUserText =
            payload.role === 'user' ? extractRawUserTranscriptText(record) : undefined;
        const systemEvent = rawUserText && classifySystemEvent(rawUserText);
        if (systemEvent) {
            builder.addSystemEvent(systemEvent, offset, 0, timestamp);
            return;
        }
        const visible = extractVisibleTranscriptMessage(record);
        if (visible)
            builder.addMessage(
                visible.role,
                visible.text,
                offset,
                0,
                typeof payload.id === 'string' ? payload.id : undefined,
                timestamp,
            );
        return;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = timelineText(payload.name, 100) ?? 'Tool';
        builder.addTool(
            typeof payload.call_id === 'string' ? payload.call_id : undefined,
            name,
            codexToolSummary(name, payload),
            offset,
            0,
            timestamp,
            typeof payload.arguments === 'string'
                ? timelineText(payload.arguments, 2_048)
                : undefined,
        );
        return;
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const output = timelineText(payload.output, 2_048);
        builder.finishTool(
            typeof payload.call_id === 'string' ? payload.call_id : undefined,
            payload.is_error === true || payload.status === 'failed',
            timestamp,
            output,
        );
    }
}
