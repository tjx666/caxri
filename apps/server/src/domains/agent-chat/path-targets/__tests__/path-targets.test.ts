import type { AgentChatItem, AgentChatPatchOperation } from '@caxri/protocol';
import { describeAgentChatWork } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ChatPathTargets, transcriptAgentSessionId } from '../path-targets';

const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';
const TASKS = '/tmp/claude-501/-work-app/conversation/tasks';

const command = (id: string, text: string, extra: Partial<AgentChatItem> = {}): AgentChatItem =>
    ({
        id,
        type: 'command',
        command: text,
        status: 'completed',
        output: '',
        ...extra,
    }) as AgentChatItem;

const upserts = (...items: AgentChatItem[]): AgentChatPatchOperation[] =>
    items.map((item) => ({ op: 'upsertItem', item }));

const stamped = (targets: ChatPathTargets, ...items: AgentChatItem[]) =>
    targets.stamp(upserts(...items)).map((operation) => {
        if (operation.op !== 'upsertItem') throw new Error('expected an upsert');
        return operation.item;
    });

const titles = new ChatPathTargets((id) =>
    id === CONVERSATION_ID ? 'Fix the login flow' : undefined,
);

describe('ChatPathTargets', () => {
    it('names a read of a background shell output file by what the shell does', () => {
        const watcher = command('watch', 'gh pr checks 42 --watch', {
            background: true,
            taskId: 'bau8pcg1e',
            description: 'Watch CI for the PR',
        });
        const [, readOutput] = stamped(
            titles,
            watcher,
            command('read', `cat ${TASKS}/bau8pcg1e.output | tail -5`),
        );
        expect(readOutput).toMatchObject({
            pathTarget: { kind: 'taskOutput', title: 'Watch CI for the PR' },
        });
        expect(describeAgentChatWork(readOutput as never)).toMatchObject({
            label: 'Checked output',
            subject: 'Watch CI for the PR',
            isCodeSubject: false,
        });
    });

    it('names a search of an Agent conversation record by its Session title', () => {
        const [search] = stamped(
            titles,
            command(
                'search',
                `grep -n bau8pcg1e /home/me/.claude/projects/app/${CONVERSATION_ID}.jsonl`,
            ),
        );
        expect(search).toMatchObject({
            pathTarget: { kind: 'sessionTranscript', title: 'Fix the login flow' },
        });
        expect(describeAgentChatWork(search as never).subject).toBe(
            'bau8pcg1e in Fix the login flow',
        );
    });

    it('names the Read tool on a conversation record too', () => {
        const [readTool] = stamped(titles, {
            id: 'tool',
            type: 'toolCall',
            name: 'Read',
            summary: `/home/me/.claude/projects/app/${CONVERSATION_ID}.jsonl`,
            status: 'completed',
        });
        expect(describeAgentChatWork(readTool as never)).toMatchObject({
            label: 'Read',
            subject: 'Fix the login flow',
        });
    });

    it('leaves unknown task outputs and conversations as their file names', () => {
        const operations = upserts(
            command('unknown-task', `cat ${TASKS}/zzzzzzzzz.output`),
            command(
                'other',
                'cat /home/me/.claude/projects/app/99999999-2222-4333-8444-555555555555.jsonl',
            ),
        );
        expect(titles.stamp(operations)).toBe(operations);
    });
});

describe('transcriptAgentSessionId', () => {
    it('reads the conversation id each provider names its record by', () => {
        expect(transcriptAgentSessionId(`/c/projects/app/${CONVERSATION_ID}.jsonl`)).toBe(
            CONVERSATION_ID,
        );
        expect(
            transcriptAgentSessionId(
                '/c/sessions/2026/11/02/rollout-2026-11-02T10-00-00-019a0000-0000-7000-8000-000000000000.jsonl',
            ),
        ).toBe('019a0000-0000-7000-8000-000000000000');
        expect(transcriptAgentSessionId(`/g/sessions/app/${CONVERSATION_ID}/updates.jsonl`)).toBe(
            CONVERSATION_ID,
        );
        expect(transcriptAgentSessionId('/c/projects/app/agent-abc.jsonl')).toBeUndefined();
        expect(transcriptAgentSessionId('/c/notes.txt')).toBeUndefined();
    });
});
