import type { ProjectStatusDeployment, ProjectStatusState } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    checkLabel,
    deploymentStateLabel,
    markdownExcerpt,
    projectStatusStateLabel,
    publicationDescription,
    publicationLabel,
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
        hostname: 'fixture.vercel.app',
        state,
        url: 'https://fixture.vercel.app',
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
