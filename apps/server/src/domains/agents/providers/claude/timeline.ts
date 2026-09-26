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

/**
 * Input fields that name what a tool acted on, in precedence order. Mobile renders the first match as the tool's
 * subject (`Fetched <url>`, `Ran agent <description>`); a tool with none of them falls back to its name.
 */
const TOOL_SUBJECT_FIELDS = [
    'command',
    'file_path',
    'notebook_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'skill',
] as const;

function toolInputSummary(name: string, input: unknown): string {
    const fields = timelineObject(input);
    const field = TOOL_SUBJECT_FIELDS.find((key) => typeof fields?.[key] === 'string');
    return timelineSummary(field && fields?.[field], name);
}

function toolResultText(content: unknown): string | undefined {
    if (typeof content === 'string') return timelineText(content, 2_048);
    if (!Array.isArray(content)) return;
    return timelineText(
        content
            .flatMap((block: unknown) => {
                const entry = timelineObject(block);
                return entry?.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
            })
            .join('\n'),
        2_048,
    );
}

/**
 * Claude Code writes full message blocks, including tool uses, into assistant/user JSONL records.
 */
export function appendClaudeTimelineRecord(
    builder: TimelineBuilder,
    value: unknown,
    offset: number,
): void {
    const record = timelineObject(value);
    if (
        !record ||
        (record.type !== 'user' && record.type !== 'assistant' && record.type !== 'system')
    )
        return;
    if (record.isMeta === true || record.isSidechain === true) return;
    const timestamp = timelineTimestamp(record.timestamp);
    if (record.type === 'system') {
        if (record.subtype === 'turn_duration') {
            const duration = record.durationMs;
            builder.addBoundary(
                offset,
                0,
                typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
                    ? Math.floor(duration)
                    : undefined,
                timestamp,
            );
        }
        return;
    }
    const message = timelineObject(record.message);
    const nativeId = typeof message?.id === 'string' ? message.id : undefined;
    const rawUserText = record.type === 'user' ? extractRawUserTranscriptText(record) : undefined;
    const systemEvent = rawUserText && classifySystemEvent(rawUserText);
    if (systemEvent) {
        builder.addSystemEvent(systemEvent, offset, 0, timestamp);
    } else {
        const visible = extractVisibleTranscriptMessage(record);
        if (visible)
            builder.addMessage(
                visible.role,
                visible.text,
                offset,
                0,
                nativeId ?? (typeof record.uuid === 'string' ? record.uuid : undefined),
                timestamp,
            );
    }
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const [index, block] of blocks.entries()) {
        const part = timelineObject(block);
        if (part?.type === 'tool_use') {
            const name = timelineText(part.name, 100) ?? 'Tool';
            builder.addTool(
                typeof part.id === 'string' ? part.id : undefined,
                name,
                toolInputSummary(name, part.input),
                offset,
                index + 1,
                timestamp,
                toolResultText(part.input),
            );
        } else if (part?.type === 'tool_result') {
            builder.finishTool(
                typeof part.tool_use_id === 'string' ? part.tool_use_id : undefined,
                part.is_error === true,
                timestamp,
                toolResultText(part.content),
            );
        }
    }
}
