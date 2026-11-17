import type { ProjectStatusDeployment, ProjectStatusState } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    checkLabel,
    deploymentStateLabel,
    durationLabel,
    elapsedLabel,
    markdownExcerpt,
    projectStatusStateLabel,
    publicationDescription,
    publicationLabel,
    spokenDurationLabel,
} from '../status-labels';

const STATES = [
    'success',
    'failure',
    'cancelled',
    'pending',
    'queued',
    'neutral',
    'unknown',
] as const satisfies readonly ProjectStatusState[];

const PUBLICATION_STATES = [
    'checking',
    'unpublished',
    'published',
    'synced',
    'ahead',
    'behind',
    'diverged',
    'unknown',
    'no-origin',
    'unsupported',
    'detached',
    'unborn',
] as const;

function deployment(state: ProjectStatusState): ProjectStatusDeployment {
    return {
        environment: 'preview',
        hostname: 'fixture.example.vercel.app',
        state,
        url: 'https://fixture.example.vercel.app',
        inspectorUrl: 'https://vercel.example/inspect',
    };
}

describe('Project Status labels', () => {
    it('translates the provider words that are not the product words', () => {
        expect(projectStatusStateLabel('success')).toBe('passed');
        expect(projectStatusStateLabel('failure')).toBe('failed');
        expect(projectStatusStateLabel('cancelled')).toBe('canceled');
        // `pending` is the state of a check that is executing, so it says so: the word "pending" would read as the
        // queue it is specifically not in.
        expect(projectStatusStateLabel('pending')).toBe('running');
        expect(projectStatusStateLabel('queued')).toBe('queued');
        // The rest already read as plain English, so they pass through rather than being renamed for its own sake.
        expect(projectStatusStateLabel('neutral')).toBe('neutral');
        expect(projectStatusStateLabel('unknown')).toBe('unknown');
    });

    it('builds every CI label from the same word, so the two can never drift apart', () => {
        for (const state of STATES)
            expect(checkLabel(state)).toBe(`CI ${projectStatusStateLabel(state)}`);
    });

    it('names an unknown state rather than leaving the surface blank', () => {
        expect(projectStatusStateLabel('unknown')).toBe('unknown');
        expect(checkLabel('unknown')).toBe('CI unknown');
    });

    it('spells a cancellation one way wherever it comes from', () => {
        // GitHub reports `cancelled`; Vercel reports the same outcome as `neutral`.
        expect(projectStatusStateLabel('cancelled')).toBe('canceled');
        expect(deploymentStateLabel(deployment('neutral'))).toBe('canceled');
        expect(checkLabel('cancelled')).toBe('CI canceled');
    });

    it('keeps a deployment on the shared words for every other state', () => {
        expect(deploymentStateLabel(deployment('success'))).toBe('passed');
        expect(deploymentStateLabel(deployment('failure'))).toBe('failed');
        expect(deploymentStateLabel(deployment('pending'))).toBe('running');
        expect(deploymentStateLabel(deployment('queued'))).toBe('queued');
    });

    it('gives a failed check and an unsupported remote different answers', () => {
        const failed = publicationLabel({ state: 'unknown' });
        const unsupported = publicationLabel({ state: 'unsupported' });

        expect(failed).not.toBe(unsupported);
        expect(failed).toBe('Check failed');
        expect(unsupported).toBe('Not supported');
    });

    it('gives every publication state its own label and its own explanation', () => {
        const labels = PUBLICATION_STATES.map((state) => publicationLabel({ state }));
        const descriptions = PUBLICATION_STATES.map((state) => publicationDescription(state));

        expect(new Set(labels).size).toBe(labels.length);
        expect(new Set(descriptions).size).toBe(descriptions.length);
        expect(labels.every((label) => label.length > 0)).toBe(true);
    });

    it('counts the commits a divergence is made of', () => {
        expect(publicationLabel({ state: 'ahead', ahead: 2 })).toBe('↑2');
        expect(publicationLabel({ state: 'behind', behind: 1 })).toBe('↓1');
        expect(publicationLabel({ state: 'diverged', ahead: 2, behind: 1 })).toBe('↑2 ↓1');
        // A count the provider never sent reads as zero rather than as `undefined`.
        expect(publicationLabel({ state: 'ahead' })).toBe('↑0');
    });
});

describe('markdownExcerpt', () => {
    it('reads a review-bot comment as prose instead of Markdown source', () => {
        expect(
            markdownExcerpt(
                '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub> Retry the handoff**\n\nIf `resume` throws, see [docs](https://example.com).',
                200,
            ),
        ).toBe('P1 Badge Retry the handoff If resume throws, see docs.');
        expect(markdownExcerpt('- one\n> two', 20)).toBe('one two');
    });
});

describe('check time labels', () => {
    it('keeps seconds and minutes below an hour', () => {
        expect(durationLabel(45_000)).toBe('45s');
        expect(durationLabel(72_000)).toBe('1m 12s');
        expect(durationLabel(59 * 60_000)).toBe('59m');
        expect(elapsedLabel(10_000)).toBe('<1m');
        expect(elapsedLabel(12 * 60_000 + 30_000)).toBe('12m');
        expect(durationLabel(undefined)).toBeUndefined();
    });

    it('reads hours and minutes from an hour up, for elapsed and settled alike', () => {
        expect(elapsedLabel(125 * 60_000)).toBe('2h 5m');
        expect(durationLabel(125 * 60_000 + 40_000)).toBe('2h 5m');
        expect(elapsedLabel(60 * 60_000)).toBe('1h');
        expect(durationLabel(3_600_000)).toBe('1h');
    });

    it('speaks the same spans in words', () => {
        expect(spokenDurationLabel(12 * 60_000 + 30_000, false)).toBe('12 minutes');
        expect(spokenDurationLabel(10_000, false)).toBe('less than a minute');
        expect(spokenDurationLabel(72_000, true)).toBe('1 minute 12 seconds');
        expect(spokenDurationLabel(45_000, true)).toBe('45 seconds');
        expect(spokenDurationLabel(125 * 60_000 + 40_000, true)).toBe('2 hours 5 minutes');
        expect(spokenDurationLabel(3_600_000, false)).toBe('1 hour');
    });
});
