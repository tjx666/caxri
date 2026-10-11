// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { CommanderInboxItem, Principal, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import { invokeMobileCommanderInboxRequest } from '../commander-inbox-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import {
    authorizeMobileSubscriptionResource,
    isMobileSubscriptionEvent,
    mobileSubscriptionMethod,
} from '../subscription-authority';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

const item = (overrides: Partial<CommanderInboxItem>): CommanderInboxItem => ({
    id: 'item-1',
    kind: 'decision',
    status: 'open',
    title: 'Pick a table name',
    body: 'Which one?',
    options: ['users', 'accounts'],
    replies: [],
    acknowledgedSequence: 0,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
});

function domainFixture(items: CommanderInboxItem[]) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method) => {
            if (method === 'commander.inbox.list') return { generatedAt: 3_000, items };
            if (method === 'mobile.commanderInbox.replyInternal') return { sequence: 1 };
            throw new Error(`Unexpected ${method}`);
        },
    );
    return { domainService: { request } as unknown as ServerDomainService, request };
}

describe('mobile Commander Inbox requests', () => {
    it('lists only open items, questions before pull requests, without merge-only fields', async () => {
        const domain = domainFixture([
            item({
                id: 'merge-1',
                kind: 'merge',
                title: 'Fix the widget',
                options: [],
                pullRequest: {
                    url: 'https://github.com/acme/widgets/pull/7',
                    owner: 'acme',
                    repo: 'widgets',
                    number: 7,
                    headSha: 'a'.repeat(40),
                },
            }),
            item({ id: 'closed-1', status: 'closed', closeReason: 'resolved' }),
            item({ id: 'hands-1', kind: 'hands', title: 'Log in to the registry' }),
        ]);
        const reauthorize = vi.fn();
        const result = await invokeMobileCommanderInboxRequest(
            { method: 'mobile.commanderInbox.list', params: {} },
            principal,
            domain.domainService,
            reauthorize,
        );
        expect(domain.request).toHaveBeenCalledWith('commander.inbox.list', {});
        expect(reauthorize).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            total: 2,
            truncated: false,
            items: [
                { id: 'hands-1', kind: 'hands' },
                {
                    id: 'merge-1',
                    pullRequest: {
                        url: 'https://github.com/acme/widgets/pull/7',
                        repo: 'widgets',
                        number: 7,
                    },
                },
            ],
        });
        expect(JSON.stringify(result)).not.toContain('headSha');
    });

    it('stores a reply through the internal method with the paired principal', async () => {
        const domain = domainFixture([]);
        const reauthorize = vi.fn();
        await expect(
            invokeMobileCommanderInboxRequest(
                { method: 'mobile.commanderInbox.reply', params: { id: 'item-1', body: 'users' } },
                principal,
                domain.domainService,
                reauthorize,
            ),
        ).resolves.toEqual({ sequence: 1 });
        expect(domain.request).toHaveBeenCalledWith('mobile.commanderInbox.replyInternal', {
            id: 'item-1',
            body: 'users',
            principal,
        });
        expect(reauthorize).toHaveBeenCalledTimes(1);
    });

    it('admits only control devices, because the Inbox spans every Project', () => {
        for (const method of ['mobile.commanderInbox.list', 'mobile.commanderInbox.reply']) {
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        }
    });

    it('gates the live subscription on the list grant and forwards only Inbox changes', async () => {
        const resource = { kind: 'commanderInbox' } as const;
        expect(mobileSubscriptionMethod(resource)).toBe('mobile.commanderInbox.list');
        const domain = domainFixture([]);
        await expect(
            authorizeMobileSubscriptionResource(domain.domainService, principal, resource),
        ).resolves.toBeUndefined();
        const changed = {
            event: 'commanderInbox.changed',
            payload: { itemIds: ['item-1'] },
        } as ServerEvent;
        const other = { event: 'state.changed', payload: {} } as unknown as ServerEvent;
        await expect(
            isMobileSubscriptionEvent(domain.domainService, principal, resource, changed),
        ).resolves.toBe(true);
        await expect(
            isMobileSubscriptionEvent(domain.domainService, principal, resource, other),
        ).resolves.toBe(false);
    });
});
