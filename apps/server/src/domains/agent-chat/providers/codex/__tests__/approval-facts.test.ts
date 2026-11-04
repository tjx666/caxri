import type { AgentChatItem, AgentChatRequest } from '@caxri/protocol';
import { MAX_AGENT_CHAT_FILE_CHANGES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { codexOffers } from '../../../approval/codex-decisions';
import type { AgentChatSessionHost } from '../../../chat-provider';
import type { JsonRpcConnection } from '../../../json-rpc-connection';
import { completeCodexPaths, renamedMarker } from '../approval/request-paths';
import { mapCodexItem } from '../items';
import { CodexPermissions, codexPermissionSettings } from '../permissions';
import { CodexRequestBroker } from '../requests';

describe('codexOffers', () => {
    it.each([
        ['no list', {}, { accept: true, decline: true }],
        [
            'a list that is not an array',
            { availableDecisions: 'accept' },
            { accept: true, decline: true },
        ],
        [
            'accept and cancel',
            { availableDecisions: ['accept', 'cancel'] },
            { accept: true, decline: true },
        ],
        [
            'accept and decline',
            { availableDecisions: ['accept', 'decline'] },
            { accept: true, decline: true },
        ],
        ['accept only', { availableDecisions: ['accept'] }, { accept: true, decline: false }],
        ['decline only', { availableDecisions: ['decline'] }, { accept: false, decline: true }],
        ['an empty list', { availableDecisions: [] }, { accept: false, decline: false }],
        [
            'only an unknown entry',
            { availableDecisions: [{ somethingNew: {} }] },
            { accept: false, decline: false },
        ],
        [
            'an amendment without a plain accept',
            {
                availableDecisions: [
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } },
                    'cancel',
                ],
            },
            { accept: false, decline: true },
        ],
    ])('reads %s', (_name, parameters, expected) => {
        expect(codexOffers(parameters)).toEqual(expected);
    });
});

describe('CodexRequestBroker offers', () => {
    function fixture() {
        const host = {
            read: () => ({ items: [] as AgentChatItem[], requests: [] as AgentChatRequest[] }),
            apply: vi.fn(),
            lifecycle: vi.fn(),
            onProtocolRejected: vi.fn(),
        } as unknown as AgentChatSessionHost;
        const connection = {
            respond: vi.fn(),
            respondError: vi.fn(),
        } as unknown as JsonRpcConnection;
        return { broker: new CodexRequestBroker(host, () => 'thread'), connection };
    }
    const approval = (extra: Record<string, unknown>) => ({
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'cmd', turnId: 't', command: 'ls', ...extra },
    });

    it('reports what Codex offers for a pending approval, and rewrites it when the request is received again', () => {
        const { broker, connection } = fixture();
        broker.receive(connection, approval({ availableDecisions: ['accept'] }));
        expect(broker.offers('cmd')).toEqual({ accept: true, decline: false });

        broker.receive(connection, approval({ availableDecisions: ['cancel'] }));
        expect(broker.offers('cmd')).toEqual({ accept: false, decline: true });
    });

    it('has no offers for an unknown request or a question', () => {
        const { broker, connection } = fixture();
        broker.receive(connection, {
            id: 2,
            method: 'item/tool/requestUserInput',
            params: { itemId: 'q', turnId: 't', questions: [] },
        });

        expect(broker.offers('nope')).toBeUndefined();
        expect(broker.offers('q')).toBeUndefined();
    });
});

describe('Codex appliedPermission', () => {
    function permissions(isPlanMode = false) {
        const host = {
            apply: vi.fn(),
            read: () => ({ model: 'fake-model' }),
        } as unknown as ConstructorParameters<typeof CodexPermissions>[0];
        const settings = codexPermissionSettings('acceptEdits') as ConstructorParameters<
            typeof CodexPermissions
        >[1];
        return new CodexPermissions(host, settings, isPlanMode);
    }
    const connection = {} as JsonRpcConnection;

    it('is applied once the thread reports its mode', () => {
        const codex = permissions();
        codex.reportOpened('default');

        expect(codex.appliedPermission()).toEqual({
            permissionMode: 'acceptEdits',
            planMode: false,
            applied: true,
        });
    });

    it('is unapplied while a level switch waits for the next turn, and applied after the turn commits', async () => {
        const codex = permissions();
        codex.reportOpened('default');
        await codex.set({ permissionMode: 'fullAccess', planMode: false }, connection, '/');

        expect(codex.appliedPermission()).toMatchObject({
            permissionMode: 'fullAccess',
            applied: false,
        });

        codex.turnParameters({ model: 'fake-model' }).commit();
        expect(codex.appliedPermission()).toMatchObject({
            permissionMode: 'fullAccess',
            applied: true,
        });
    });

    it('is unapplied while plan mode differs from the thread collaboration mode', async () => {
        const codex = permissions();
        codex.reportOpened('default');
        await codex.set({ planMode: true }, connection, '/');

        expect(codex.appliedPermission()).toMatchObject({ planMode: true, applied: false });

        codex.turnParameters({ model: 'fake-model' }).commit();
        expect(codex.appliedPermission()).toMatchObject({ planMode: true, applied: true });
    });
});

describe('Codex file change paths', () => {
    const item = (changes: Array<Record<string, unknown>>) =>
        ({
            id: 'edit',
            type: 'fileChange',
            status: 'running',
            changes,
        }) as unknown as AgentChatItem;
    const change = (path: string, extra: Record<string, unknown> = {}) => ({
        path,
        kind: 'update',
        diff: '',
        ...extra,
    });

    it('returns the paths only when they are provably the whole set', () => {
        const source = item([change('/r/a.ts'), change('/r/b.ts', { kind: 'add' })]);
        expect(completeCodexPaths(source, {})).toEqual(['/r/a.ts', '/r/b.ts']);
    });

    const cappedPath = `/${'x'.repeat(4095)}`;
    const cappedList = Array.from({ length: MAX_AGENT_CHAT_FILE_CHANGES }, (_, index) =>
        change(`/r/${index}`),
    );
    it.each([
        ['no source item', undefined, {}],
        ['a command item', { id: 'c', type: 'commandExecution' } as unknown as AgentChatItem, {}],
        ['no changes', item([]), {}],
        ['a delete', item([change('/r/a.ts', { kind: 'delete' })]), {}],
        ['a rename', item([change('/r/a.ts', { renamed: true })]), {}],
        ['an empty path', item([change('')]), {}],
        ['a path at the projection cap', item([change(cappedPath)]), {}],
        ['a widened root', item([change('/r/a.ts')]), { grantRoot: '/r' }],
        ['a list at the mapper cap', item(cappedList), {}],
    ])('returns no paths for %s', (_name, source, parameters) => {
        expect(completeCodexPaths(source, parameters)).toBeUndefined();
    });

    it('marks a move or an unknown kind as renamed, and a plain edit as not', () => {
        expect(renamedMarker({ kind: { type: 'add' } })).toEqual({});
        expect(renamedMarker({ kind: { type: 'delete' } })).toEqual({});
        expect(renamedMarker({ kind: { type: 'update', move_path: null } })).toEqual({});
        expect(renamedMarker({ kind: { type: 'update', move_path: '' } })).toEqual({});
        expect(renamedMarker({ kind: { type: 'update', move_path: '/r/new.ts' } })).toEqual({
            renamed: true,
        });
        expect(renamedMarker({ kind: { type: 'somethingNew' } })).toEqual({ renamed: true });
        expect(renamedMarker({})).toEqual({});
    });

    it('carries the rename mark through the item mapper so a move never reads as an edit', () => {
        const mapped = mapCodexItem(
            {
                id: 'edit',
                type: 'fileChange',
                status: 'completed',
                changes: [
                    {
                        path: '/r/old.ts',
                        kind: { type: 'update', move_path: '/r/new.ts' },
                        diff: '',
                    },
                    { path: '/r/b.ts', kind: { type: 'update', move_path: null }, diff: '' },
                ],
            },
            'turn-1',
            false,
        );

        expect(mapped).toMatchObject({
            type: 'fileChange',
            changes: [{ path: '/r/old.ts', renamed: true }, { path: '/r/b.ts' }],
        });
        expect(
            (mapped as { changes: Array<{ renamed?: boolean }> }).changes[1].renamed,
        ).toBeUndefined();
    });
});
