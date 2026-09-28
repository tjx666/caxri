import { describe, expect, it, vi } from 'vitest';

import { AcceptanceStore, ExternalStatusCliError } from '../../external-status';
import {
    collectAcceptanceCandidates,
    loadOverviewAcceptances,
    loadPullRequestAcceptances,
} from '../acceptance';

const ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = 'f0e1d2c3-b4a5-4968-8778-695a4b3c2d1e';
const link = (id: string, round?: number): string =>
    `https://app.lobehub.com/acceptance/${id}${round ? `?turn=${round}` : ''}`;

function bundle(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        acceptance: { status: 'delivered' },
        latestReport: { passedChecks: 11, totalChecks: 12, verdict: 'passed' },
        rounds: [
            {
                report: { passedChecks: 4, totalChecks: 12, verdict: 'failed' },
                run: { roundIndex: 1 },
            },
            {
                report: { passedChecks: 11, totalChecks: 12, verdict: 'passed' },
                run: { roundIndex: 2 },
            },
        ],
        subject: { title: 'Recover a diff whose worker never started' },
        ...overrides,
    });
}

describe('acceptance candidate collection', () => {
    it('leads with what the pull request states, then fills in from the conversation', () => {
        expect(
            collectAcceptanceCandidates({
                conversation: [{ id: OTHER }],
                pullRequestBody: `Delivers ${link(ID, 2)}`,
            }),
        ).toEqual([
            { id: ID, round: 2, source: 'pull-request' },
            { id: OTHER, source: 'conversation' },
        ]);
    });

    it('does not let a conversation repeat demote the statement the pull request made', () => {
        expect(
            collectAcceptanceCandidates({
                conversation: [{ id: ID, round: 5 }],
                pullRequestBody: link(ID, 2),
            }),
        ).toEqual([{ id: ID, round: 2, source: 'pull-request' }]);
    });

    it('answers for a branch whose pull request does not exist yet', () => {
        expect(collectAcceptanceCandidates({ conversation: [{ id: ID }] })).toEqual([
            { id: ID, source: 'conversation' },
        ]);
    });

    it('caps how many reports one branch may lead with', () => {
        const ids = Array.from(
            { length: 6 },
            (_, index) => `00000000-0000-4000-8000-00000000000${index}`,
        );
        expect(
            collectAcceptanceCandidates({ pullRequestBody: ids.map((id) => link(id)).join(' ') }),
        ).toHaveLength(4);
    });
});

describe('Status panel acceptance rows', () => {
    it('resolves the round the link pinned rather than the latest one', async () => {
        const runner = vi.fn().mockResolvedValue(bundle());
        const store = new AcceptanceStore(runner);
        const { acceptances, error } = await loadPullRequestAcceptances(
            store,
            '/project',
            `Delivers ${link(ID, 1)}`,
            { isForced: false, onParseFailure: () => {} },
        );
        expect(error).toBeUndefined();
        expect(acceptances).toEqual([
            {
                id: ID,
                // The pinned round failed, so the report reads as failing even though its lifecycle moved on.
                state: 'failure',
                status: 'delivered',
                url: link(ID, 1),
                round: 1,
                title: 'Recover a diff whose worker never started',
                verdict: 'failed',
                passedChecks: 4,
                totalChecks: 12,
                roundCount: 2,
            },
        ]);
    });

    it('reports the provider failure and still renders the link that produced it', async () => {
        const store = new AcceptanceStore(
            vi.fn().mockRejectedValue(new ExternalStatusCliError('lh', 'not-found', 'missing')),
        );
        const { acceptances, error } = await loadPullRequestAcceptances(
            store,
            '/project',
            link(ID),
            { isForced: false, onParseFailure: () => {} },
        );
        expect(error).toMatchObject({ source: 'acceptance', kind: 'prerequisite' });
        // Never the report id: it names a private acceptance record and the subject persists into a `warn` record.
        expect(JSON.stringify(error)).not.toContain(ID);
        expect(acceptances).toEqual([{ id: ID, state: 'unknown', url: link(ID) }]);
    });

    it('spawns the CLI once for a report two rounds of which are linked', async () => {
        const runner = vi.fn().mockResolvedValue(bundle());
        const store = new AcceptanceStore(runner);
        const { acceptances } = await loadPullRequestAcceptances(
            store,
            '/project',
            `${link(ID, 1)} and ${link(OTHER)}`,
            { isForced: false, onParseFailure: () => {} },
        );
        expect(acceptances).toHaveLength(2);
        expect(runner).toHaveBeenCalledTimes(2);
        expect(runner.mock.calls[0][0]).toEqual([
            'acceptance',
            'view',
            ID,
            '--json',
            'acceptance,subject,latestReport,rounds',
        ]);
    });
});

describe('status bar acceptance chip', () => {
    it('resolves only the leading report and leaves the tail as links', async () => {
        const runner = vi.fn().mockResolvedValue(bundle());
        const acceptances = await loadOverviewAcceptances(new AcceptanceStore(runner), '/project', {
            conversation: [{ id: OTHER }],
            pullRequestBody: link(ID),
        });
        expect(runner).toHaveBeenCalledTimes(1);
        expect(acceptances).toEqual([
            expect.objectContaining({ id: ID, source: 'pull-request', state: 'pending' }),
            { id: OTHER, state: 'unknown', url: link(OTHER), source: 'conversation' },
        ]);
    });

    it('degrades a failed lookup to the bare link instead of surfacing a provider error', async () => {
        const store = new AcceptanceStore(vi.fn().mockRejectedValue(new Error('no lh')));
        const acceptances = await loadOverviewAcceptances(store, '/project', {
            conversation: [],
            pullRequestBody: link(ID, 2),
        });
        expect(acceptances).toEqual([
            { id: ID, state: 'unknown', url: link(ID, 2), round: 2, source: 'pull-request' },
        ]);
    });

    it('remembers a failure so a repeated poll does not respawn the CLI', async () => {
        const runner = vi.fn().mockRejectedValue(new Error('no lh'));
        const store = new AcceptanceStore(runner);
        const sources = { conversation: [], pullRequestBody: link(ID) };
        await loadOverviewAcceptances(store, '/project', sources);
        await loadOverviewAcceptances(store, '/project', sources);
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('renders nothing when neither source named a report', async () => {
        const runner = vi.fn();
        const acceptances = await loadOverviewAcceptances(new AcceptanceStore(runner), '/project', {
            conversation: [],
            pullRequestBody: 'Fixes #12 and updates the docs.',
        });
        expect(acceptances).toEqual([]);
        expect(runner).not.toHaveBeenCalled();
    });
});
