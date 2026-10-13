import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAgentTitleMessages } from '../title-generation';
import type { AgentTranscriptLocation } from '../transcript-security';

describe('Session title record bounds', () => {
    const message = (role: 'assistant' | 'user', text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role,
                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            },
        });

    it('discards an oversized record and resumes at the next complete line', async () => {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-bound-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(
            path,
            `${[
                message('user', 'opening request'),
                message('assistant', 'opening reply'),
                /**
                 * A parseable message this large is a paste, not naming material. Without the record bound it would
                 * both buffer whole in Server memory and occupy a slot in the latest exchange.
                 */
                message('user', `oversized paste ${'x'.repeat(700_000)}`),
                message('user', 'closing request'),
            ].join('\n')}\n`,
            'utf8',
        );
        const context = await readAgentTitleMessages({ baseRoot, path, root });
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'opening request',
            'opening reply',
        ]);
        expect(context.recent.map((entry) => entry.text)).toEqual(['closing request']);
        await rm(baseRoot, { force: true, recursive: true });
    });

    /**
     * Pasted screenshots are stored as base64 inside the prompt record itself. Two of them pushed a real opening
     * request past the record bound, so the Session was later named after a background task notification instead.
     */
    it.each([
        {
            provider: 'Claude',
            opening: JSON.stringify({
                type: 'user',
                message: {
                    content: [
                        { type: 'text', text: 'translate the video prompt' },
                        { type: 'image', source: { type: 'base64', data: 'A'.repeat(300_000) } },
                    ],
                },
            }),
        },
        {
            provider: 'Codex',
            opening: JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'translate the video prompt' },
                        {
                            type: 'input_image',
                            image_url: `data:image/png;base64,${'A'.repeat(300_000)}`,
                        },
                    ],
                },
            }),
        },
    ])('keeps a $provider opening request that carries inline screenshots', async ({ opening }) => {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-media-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        const notification = JSON.stringify({
            type: 'user',
            promptSource: 'system',
            message: {
                content:
                    '<task-notification>\n<summary>Keep polling PR checks</summary>\n</task-notification>',
            },
        });
        await writeFile(
            path,
            `${[opening, message('assistant', 'opening reply'), notification].join('\n')}\n`,
            'utf8',
        );
        const context = await readAgentTitleMessages({ baseRoot, path, root });
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'translate the video prompt',
            'opening reply',
        ]);
        expect(context.recent).toEqual([]);
        await rm(baseRoot, { force: true, recursive: true });
    });
});

describe('Session title split-window scanning', () => {
    const message = (role: 'assistant' | 'user', text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role,
                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            },
        });
    const toolNoise = (bytes: number): string =>
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', output: 'x'.repeat(bytes) },
        });
    /**
     * Roughly 9MB, so two of them push the transcript past the scan budget and split the windows apart.
     */
    const filler = `${toolNoise(200_000)}\n`.repeat(45);

    /**
     * A transcript past the scan budget is read as an opening window plus a tail window. Only a real oversized file
     * exercises the mid-record range start, the fragment drop that follows it, and the window split itself.
     */
    async function writeOversizedTranscript(
        lines: readonly string[],
    ): Promise<AgentTranscriptLocation> {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-split-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(path, lines.join(''), 'utf8');
        expect((await stat(path)).size).toBeGreaterThan(16 * 1024 * 1024);
        return { baseRoot, path, root };
    }

    it('takes the opening from the first window and never lets it fill the latest exchange', async () => {
        const location = await writeOversizedTranscript([
            `${message('user', 'investigate the circuit breaker alert')}\n`,
            `${message('assistant', 'checking the upstream channel now')}\n`,
            `${message('assistant', 'still inside the opening window')}\n`,
            filler,
            `${message('assistant', 'the breaker entries already cleared')}\n`,
            filler,
            `${message('user', 'just cancel')}\n`,
            `${message('assistant', 'moved it to canceled')}\n`,
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'investigate the circuit breaker alert',
            'checking the upstream channel now',
        ]);
        /**
         * The middle message sits inside the tail window, so the window reaches back past the last exchange. The
         * opening window's third message does not, even though it was scanned.
         */
        expect(context.recent.map((entry) => entry.text)).toEqual([
            'the breaker entries already cleared',
            'just cancel',
            'moved it to canceled',
        ]);
        await rm(location.baseRoot, { force: true, recursive: true });
    });

    it('reports no opening rather than promoting the tail when the first window holds no request', async () => {
        const location = await writeOversizedTranscript([
            `${message('assistant', 'resumed from a previous thread')}\n`,
            filler,
            filler,
            `${message('user', 'just cancel')}\n`,
            `${message('assistant', 'moved it to canceled')}\n`,
        ]);
        const context = await readAgentTitleMessages(location);
        expect(context.opening).toEqual([]);
        expect(context.recent.map((entry) => entry.text)).toEqual([
            'just cancel',
            'moved it to canceled',
        ]);
        await rm(location.baseRoot, { force: true, recursive: true });
    });
});

describe('Session title ordering', () => {
    const message = (role: 'assistant' | 'user', text: string): string =>
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role,
                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            },
        });

    it('excludes assistant output that precedes the opening request from the latest exchange', async () => {
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-title-order-'));
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'transcript.jsonl');
        await writeFile(
            path,
            `${[
                message('assistant', 'resumed from a previous thread'),
                message('assistant', 'restoring the worktree lease'),
                message('user', 'investigate the alert'),
                message('assistant', 'checking it now'),
                message('user', 'just cancel'),
            ].join('\n')}\n`,
            'utf8',
        );
        const context = await readAgentTitleMessages({ baseRoot, path, root });
        expect(context.opening.map((entry) => entry.text)).toEqual([
            'investigate the alert',
            'checking it now',
        ]);
        expect(context.recent.map((entry) => entry.text)).toEqual(['just cancel']);
        await rm(baseRoot, { force: true, recursive: true });
    });
});
