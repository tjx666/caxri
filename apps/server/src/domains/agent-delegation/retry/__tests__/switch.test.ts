import { describe, expect, it } from 'vitest';

import { retryDelegationId } from '../support';
import { retrySwitchTargets } from '../switch';
import { fixture, reasonOf } from './fixture';

const installed = (providers: string[]) => (provider: string) =>
    Promise.resolve(providers.includes(provider));

describe('retry with another Agent', () => {
    it('lists installed, unguarded Agents other than the failed one in static order', async () => {
        const options = {
            isProviderInstalled: installed(['antigravity', 'codex', 'claude', 'grok']),
            isProviderGuarded: (provider: string) => provider === 'grok',
        };

        expect(await retrySwitchTargets(options, 'claude')).toEqual(['codex', 'antigravity']);
        expect(await retrySwitchTargets(options, 'codex')).toEqual(['claude', 'antigravity']);
        expect(await retrySwitchTargets({}, 'claude')).toEqual([]);
    });

    it('offers switch targets only while a fresh retry is available', async () => {
        const { database, failedTask, service, stored } = await fixture({
            isProviderInstalled: installed(['claude', 'codex']),
        });
        const failed = await failedTask();

        expect((await service.retries.options(failed.id)).switchTargets).toEqual(['codex']);

        database.agentDelegations.save({ ...stored(failed.id), hasHumanIntervention: true });
        expect((await service.retries.options(failed.id)).switchTargets).toEqual([]);
    });

    it('starts a fresh task on the target Agent without carrying the model over', async () => {
        const { database, failedTask, service, start, stored } = await fixture({
            isProviderInstalled: installed(['claude', 'codex']),
        });
        const failed = await failedTask();
        const record = stored(failed.id);
        // The failed task ran on a model of its own Agent.
        database.agentDelegations.save({
            ...record,
            receipt: {
                ...record.receipt,
                selection: { provider: 'claude', model: 'opus', effort: 'high' },
            },
        });

        const reply = await service.retries.retry(failed.id, 'fresh', undefined, 'codex');

        expect(reply.status).toBe('started');
        const successor = stored(retryDelegationId(failed.id));
        expect(successor.receipt.provider).toBe('codex');
        expect(successor.receipt.selection?.model).toBeUndefined();
        expect(successor.receipt.selection?.effort).toBeUndefined();
        expect(start.mock.calls.at(-1)?.[2].provider).toBe('codex');
        expect(stored(failed.id)).toMatchObject({
            retryMode: 'fresh',
            retryProvider: 'codex',
            receipt: { provider: 'claude', retriedAs: successor.receipt.delegationId },
        });
    });

    it('carries the forced surface into the successor instead of re-resolving the setting', async () => {
        const { database, failedTask, service, stored } = await fixture({
            hasAgentChat: () => true,
            opensAgentsInChat: () => true,
        });
        const failed = await failedTask();
        const record = stored(failed.id);
        database.agentDelegations.save({
            ...record,
            input: { ...record.input, surface: 'pty' },
        });

        await service.retries.retry(failed.id, 'fresh');

        // The setting is on, so a successor that dropped `surface` would have opened as a Chat.
        const successor = stored(retryDelegationId(failed.id));
        expect(successor.input.surface).toBe('pty');
        expect(successor.receipt.surface).toBe('pty');
    });

    it('shares only an identical request and refuses a different mode or Agent', async () => {
        const { failedTask, service, start } = await fixture({
            isProviderInstalled: installed(['claude', 'codex', 'grok']),
        });
        const failed = await failedTask();
        const startsBefore = start.mock.calls.length;

        const first = await service.retries.retry(failed.id, 'fresh', undefined, 'codex');
        const second = await service.retries.retry(failed.id, 'fresh', undefined, 'codex');

        expect(second).toEqual(first);
        expect(start.mock.calls.length - startsBefore).toBe(1);
        expect(await reasonOf(service.retries.retry(failed.id, 'fresh', undefined, 'grok'))).toBe(
            'already_retried',
        );
        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('already_retried');
        expect(await reasonOf(service.retries.retry(failed.id, 'resume'))).toBe('already_retried');
    });

    it('refuses a switch after a plain fresh retry', async () => {
        const { failedTask, service } = await fixture({
            isProviderInstalled: installed(['claude', 'codex']),
        });
        const plain = await failedTask();
        await service.retries.retry(plain.id, 'fresh');

        expect(await reasonOf(service.retries.retry(plain.id, 'fresh', undefined, 'codex'))).toBe(
            'already_retried',
        );
    });

    it('runs concurrent identical switches once and lets one Agent win a race', async () => {
        const { failedTask, service, start } = await fixture({
            isProviderInstalled: installed(['claude', 'codex', 'grok']),
        });
        const failed = await failedTask();
        const startsBefore = start.mock.calls.length;

        const results = await Promise.allSettled([
            service.retries.retry(failed.id, 'fresh', undefined, 'codex'),
            service.retries.retry(failed.id, 'fresh', undefined, 'codex'),
            service.retries.retry(failed.id, 'fresh', undefined, 'grok'),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
        expect(start.mock.calls.length - startsBefore).toBe(1);
    });

    it.each([
        ['not installed', { isProviderInstalled: installed(['claude']) }],
        [
            'at the usage guard',
            {
                isProviderInstalled: installed(['claude', 'codex']),
                isProviderGuarded: () => true,
            },
        ],
    ])('refuses a target that is %s without claiming', async (_name, options) => {
        const { failedTask, service, stored } = await fixture(options);
        const failed = await failedTask();

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh', undefined, 'codex'))).toBe(
            'not_retryable',
        );
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
        expect(stored(failed.id).retryProvider).toBeUndefined();
    });

    it('refuses the failed Agent itself, resume, and a schedule with a provider', async () => {
        const { failedTask, service, stored } = await fixture({
            isProviderInstalled: installed(['claude', 'codex']),
        });
        const failed = await failedTask();

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh', undefined, 'claude'))).toBe(
            'not_retryable',
        );
        expect(await reasonOf(service.retries.retry(failed.id, 'resume', undefined, 'codex'))).toBe(
            'not_retryable',
        );
        expect(await reasonOf(service.retries.retry(failed.id, 'fresh', 'reset', 'codex'))).toBe(
            'not_retryable',
        );
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });

    it('releases the target with the claim when admission refuses', async () => {
        const { failedTask, service, stored, verifyLaunch } = await fixture({
            isProviderInstalled: installed(['claude', 'codex']),
        });
        const failed = await failedTask();
        verifyLaunch.mockRejectedValueOnce(new Error('launch refused'));

        await expect(
            service.retries.retry(failed.id, 'fresh', undefined, 'codex'),
        ).rejects.toThrow();

        expect(stored(failed.id).retryProvider).toBeUndefined();
        expect(stored(failed.id).retryMode).toBeUndefined();
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });
});
