import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { CURRENT_SCHEMA_VERSION } from '../../db/connection';
import { ExternalStatusCliError } from '../../external-status';
import { CommanderInboxService } from '../inbox';

const PR_URL = 'https://github.com/acme/widgets/pull/7';
const VERIFIED_SHA = 'a'.repeat(40);
const MOVED_SHA = 'b'.repeat(40);

function pullRequestJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        number: 7,
        title: 'Fix the widget',
        url: PR_URL,
        state: 'OPEN',
        isDraft: false,
        headRefOid: VERIFIED_SHA,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
        ...overrides,
    });
}

async function fixture() {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-commander-inbox-`));
    const databasePath = join(directory, 'state.db');
    const database = new CaxriDatabase(databasePath);
    let now = 1_000;
    const events: ServerEvent[] = [];
    const notices: Array<[string, string]> = [];
    const logger = { write: vi.fn() } as unknown as StructuredLogger;
    let view: () => Promise<string | undefined> = () => Promise.resolve(pullRequestJson());
    const run = vi.fn((_command: string, arguments_: readonly string[]) =>
        Promise.resolve(
            arguments_[0] === 'repo'
                ? JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: true })
                : '',
        ),
    );
    const forget = vi.fn();
    const createService = () =>
        new CommanderInboxService({
            database,
            github: { forget, view: () => view() },
            ignoredChecks: () => [],
            logger,
            now: () => now,
            notify: (itemId, event) => notices.push([itemId, event]),
            forgetNotices: () => {
                notices.length = 0;
            },
            run,
            send: (event) => events.push(event),
            workingDirectory: directory,
        });
    const service = createService();
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    return {
        createService,
        database,
        databasePath,
        events,
        forget,
        notices,
        run,
        service,
        advance: (ms: number) => {
            now += ms;
        },
        setView: (next: () => Promise<string | undefined>) => {
            view = next;
        },
    };
}

async function rejection(promise: Promise<unknown>): Promise<CaxriError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(CaxriError);
        return error as CaxriError;
    }
    throw new Error('Expected the promise to reject');
}

function addMerge(service: CommanderInboxService, headSha = VERIFIED_SHA) {
    return service.add({
        kind: 'merge',
        title: 'Ready to merge',
        body: 'Bug, Cause, Fix, Evidence, Risk',
        options: [],
        pullRequest: { url: PR_URL, headSha },
    });
}

describe('CommanderInboxService', () => {
    it('updates the open item with the same key instead of adding a second one', async () => {
        const { events, service } = await fixture();
        const first = service.add({
            kind: 'decision',
            key: 'schema',
            title: 'Pick',
            body: '',
            options: ['A', 'B'],
        });
        const second = service.add({
            kind: 'decision',
            key: 'schema',
            title: 'Pick again',
            body: 'more',
            options: [],
        });
        expect(second.id).toBe(first.id);
        expect(second.revision).toBe(first.revision + 1);
        expect(service.list().items.map((item) => item.title)).toEqual(['Pick again']);
        expect(events.map((event) => event.event)).toEqual([
            'commanderInbox.changed',
            'commanderInbox.changed',
        ]);
        service.resolve(first.id);
        const reopened = service.add({
            kind: 'decision',
            key: 'schema',
            title: 'New',
            body: '',
            options: [],
        });
        expect(reopened.id).not.toBe(first.id);
    });

    it('splits a large reconcile into change events the event contract accepts', async () => {
        const { createService, events, service } = await fixture();
        for (let number = 1; number <= 70; number += 1)
            service.add({
                kind: 'merge',
                title: `Ready ${number}`,
                body: '',
                options: [],
                pullRequest: { url: `${PR_URL}${number}`, headSha: VERIFIED_SHA },
            });
        // A restarted Server has no live view yet, so its first sweep reports every open merge item as changed.
        const restarted = createService();
        // Let each add's own forced refresh settle first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.length = 0;
        await restarted.refresh();
        const sizes = events.map((event) =>
            event.event === 'commanderInbox.changed' ? event.payload.itemIds.length : 0,
        );
        expect(sizes).toEqual([64, 6]);
    });

    it('rejects a merge item without a pull request and a decision with one', async () => {
        const { service } = await fixture();
        expect(() => service.add({ kind: 'merge', title: 'x', body: '', options: [] })).toThrow(
            CaxriError,
        );
        expect(() =>
            service.add({
                kind: 'decision',
                title: 'x',
                body: '',
                options: [],
                pullRequest: { url: PR_URL, headSha: VERIFIED_SHA },
            }),
        ).toThrow(CaxriError);
    });

    it('persists replies, notifies the Commander, and re-announces them until acknowledged', async () => {
        const { createService, notices, service } = await fixture();
        const item = service.add({ kind: 'hands', title: 'Log in', body: '', options: [] });
        const replied = service.reply(item.id, 'done', 'desktop');
        expect(replied.replies).toEqual([
            { sequence: 1, body: 'done', source: 'desktop', createdAt: 1_000 },
        ]);
        expect(notices).toEqual([[item.id, 'replied']]);

        notices.length = 0;
        const restarted = createService();
        restarted.announceUnacknowledged();
        expect(notices).toEqual([[item.id, 'replied']]);

        expect(service.acknowledge(item.id, 1).acknowledgedSequence).toBe(1);
        expect(() => service.acknowledge(item.id, 2)).toThrow(CaxriError);
        notices.length = 0;
        restarted.announceUnacknowledged();
        expect(notices).toEqual([]);
    });

    it('notifies the Commander when the owner dismisses, but not when the Commander resolves', async () => {
        const { notices, service } = await fixture();
        const dismissed = service.add({ kind: 'decision', title: 'A', body: '', options: [] });
        const resolved = service.add({ kind: 'decision', title: 'B', body: '', options: [] });
        expect(service.dismiss(dismissed.id)).toMatchObject({
            status: 'closed',
            closeReason: 'dismissed',
        });
        expect(service.resolve(resolved.id)).toMatchObject({
            status: 'closed',
            closeReason: 'resolved',
        });
        expect(service.resolve(resolved.id).closeReason).toBe('resolved');
        expect(notices).toEqual([[dismissed.id, 'dismissed']]);
        expect(() => service.reply(dismissed.id, 'late', 'desktop')).toThrow(CaxriError);
        expect(service.list(true).items).toHaveLength(2);
    });

    it('clears every item with its replies and queued notices, and announces the removal', async () => {
        const { events, notices, service } = await fixture();
        const open = service.add({ kind: 'hands', title: 'Log in', body: '', options: [] });
        const closed = service.add({ kind: 'decision', title: 'Pick', body: '', options: [] });
        service.reply(open.id, 'done', 'desktop');
        service.resolve(closed.id);
        expect(service.counts()).toEqual({ open: 1, closed: 1 });
        events.length = 0;

        expect(service.clear()).toBe(2);

        expect(service.counts()).toEqual({ open: 0, closed: 0 });
        expect(service.list(true).items).toEqual([]);
        expect(notices).toEqual([]);
        expect(events).toEqual([
            {
                event: 'commanderInbox.changed',
                payload: { itemIds: expect.arrayContaining([open.id, closed.id]) as string[] },
            },
        ]);
        expect(() => service.show(open.id)).toThrow(CaxriError);
    });

    it('merges pinned to the verified head, closes the item, and tells the Commander', async () => {
        const { forget, notices, run, service } = await fixture();
        const item = addMerge(service);
        const result = await service.merge(item.id, item.revision);
        expect(result.method).toBe('squash');
        expect(result.item).toMatchObject({ status: 'closed', closeReason: 'merged' });
        expect(run).toHaveBeenLastCalledWith(
            'gh',
            [
                'pr',
                'merge',
                '7',
                '--repo',
                'acme/widgets',
                '--squash',
                '--match-head-commit',
                VERIFIED_SHA,
            ],
            expect.any(String),
        );
        expect(forget).toHaveBeenCalledWith('acme', 'widgets', 7);
        expect(notices).toEqual([[item.id, 'merged']]);
    });

    it('refuses to merge a report the Commander replaced after the owner read it', async () => {
        const { run, service } = await fixture();
        const read = addMerge(service);
        addMerge(service);
        expect((await rejection(service.merge(read.id, read.revision))).code).toBe('CONFLICT');
        expect(run).not.toHaveBeenCalled();
    });

    it('merges the report the owner read after a reply, an acknowledgement, or a cleared stale mark', async () => {
        const { run, service, setView } = await fixture();
        const read = addMerge(service);
        // While the confirmation is open: the owner replies, the Commander acknowledges it, and the head moves away
        // and back to the verified one. None of these changes the report or the head the merge is pinned to.
        service.reply(read.id, 'looks good', 'desktop');
        service.acknowledge(read.id, 1);
        setView(() => Promise.resolve(pullRequestJson({ headRefOid: MOVED_SHA })));
        await service.refresh();
        setView(() => Promise.resolve(pullRequestJson()));
        await service.refresh();
        expect(service.show(read.id).staleReason).toBeUndefined();

        const result = await service.merge(read.id, read.revision);
        expect(result.item).toMatchObject({ status: 'closed', closeReason: 'merged' });
        expect(run).toHaveBeenLastCalledWith(
            'gh',
            expect.arrayContaining(['--match-head-commit', VERIFIED_SHA]),
            expect.any(String),
        );
    });

    it('refuses to merge after the Commander changed the report while the owner confirmed', async () => {
        const { run, service } = await fixture();
        const read = addMerge(service);
        service.add({
            kind: 'merge',
            title: 'Ready to merge',
            body: 'Bug, Cause, Fix, Evidence, Risk, and a new caveat',
            options: [],
            pullRequest: { url: PR_URL, headSha: VERIFIED_SHA },
        });
        expect((await rejection(service.merge(read.id, read.revision))).message).toBe(
            'The Commander updated this item since you opened it; review it again',
        );
        expect(run).not.toHaveBeenCalled();
    });

    it('marks a moved head stale, refuses to merge it, and clears the mark once the Commander re-verifies', async () => {
        const { service, setView } = await fixture();
        const item = addMerge(service);
        setView(() => Promise.resolve(pullRequestJson({ headRefOid: MOVED_SHA })));
        await service.refresh();
        const stale = service.show(item.id);
        expect(stale.staleReason).toBe('headMoved');
        expect(stale.pullRequestLive).toMatchObject({ headSha: MOVED_SHA, lifecycle: 'open' });
        expect((await rejection(service.merge(item.id, stale.revision))).code).toBe('CONFLICT');

        const reverified = addMerge(service, MOVED_SHA);
        expect(reverified.staleReason).toBeUndefined();
        await service.refresh();
        expect(service.show(item.id).staleReason).toBeUndefined();
    });

    it('closes an item whose pull request was merged or closed on GitHub', async () => {
        const { notices, service, setView } = await fixture();
        const item = addMerge(service);
        setView(() => Promise.resolve(pullRequestJson({ state: 'MERGED' })));
        await service.refresh();
        expect(service.show(item.id)).toMatchObject({ status: 'closed', closeReason: 'merged' });
        expect(notices).toEqual([[item.id, 'merged']]);
    });

    it('keeps an item open and drops its live view when GitHub cannot be read', async () => {
        const { service, setView } = await fixture();
        const item = addMerge(service);
        await service.refresh();
        expect(service.show(item.id).pullRequestLive).toBeDefined();
        setView(() => Promise.reject(new ExternalStatusCliError('gh', 'rate-limited', 'limit', 1)));
        await service.refresh();
        const kept = service.show(item.id);
        expect(kept.status).toBe('open');
        expect(kept.pullRequestLive).toBeUndefined();
    });
});

describe('commander inbox migration', () => {
    it('creates the Inbox tables when upgrading from the schema version before them', async () => {
        const { database, databasePath } = await fixture();
        database.close();
        const raw = new Database(databasePath);
        raw.exec('DROP TABLE commander_inbox_replies; DROP TABLE commander_inbox_items');
        // `0006_chat_permission_modes`, `0007_benchmark_runs`, `0008_session_creator`, and `0009_agent_chat_persistence`
        // came after the Inbox, so that version predates them too.
        raw.exec(
            'ALTER TABLE projects DROP COLUMN chat_defaults; ALTER TABLE terminals DROP COLUMN chat_permission_mode; ALTER TABLE terminals DROP COLUMN chat_plan_mode',
        );
        raw.exec('DROP TABLE benchmark_runs');
        raw.exec('ALTER TABLE sessions DROP COLUMN created_by_session_id');
        raw.exec(
            'DROP TABLE agent_chat_answered_notices; DROP TABLE agent_chat_process_groups; ALTER TABLE terminals DROP COLUMN agent_resume_at',
        );
        raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 5}`);
        raw.close();

        const upgraded = new CaxriDatabase(databasePath);
        onTestFinished(() => upgraded.close());
        expect(upgraded.commanderInbox.list(true)).toEqual([]);
        const check = new Database(databasePath, { readonly: true });
        onTestFinished(() => {
            check.close();
        });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    });
});
