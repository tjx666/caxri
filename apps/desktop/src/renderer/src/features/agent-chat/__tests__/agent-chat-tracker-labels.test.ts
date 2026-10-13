import type { AgentChatTrackerArtifact, TerminalReferencePreview } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { trackerPreviewRequest, trackerPreviewTitle } from '../agent-chat-tracker-labels';

function artifact(overrides: Partial<AgentChatTrackerArtifact> = {}): AgentChatTrackerArtifact {
    return {
        provider: 'github',
        kind: 'pull',
        action: 'updated',
        url: 'https://github.com/acme/widgets/pull/7',
        reference: 'acme/widgets#7',
        ...overrides,
    };
}

function githubPreview(title: string): TerminalReferencePreview {
    return {
        kind: 'github',
        author: 'octocat',
        createdAt: 0,
        isDraft: false,
        isMerged: false,
        isPullRequest: true,
        number: 7,
        state: 'open',
        title,
        url: 'https://github.com/acme/widgets/pull/7',
    };
}

describe('trackerPreviewRequest', () => {
    it('asks for an untitled GitHub pull request or issue by its reference', () => {
        expect(trackerPreviewRequest(artifact())).toEqual({
            kind: 'github',
            owner: 'acme',
            repo: 'widgets',
            number: 7,
        });
        expect(
            trackerPreviewRequest(artifact({ kind: 'issue', reference: 'acme/widgets.js#12' })),
        ).toEqual({ kind: 'github', owner: 'acme', repo: 'widgets.js', number: 12 });
    });

    it('still asks about a titled pull request, whose glyph shows its live state', () => {
        expect(trackerPreviewRequest(artifact({ title: 'Fix login' }))).toEqual({
            kind: 'github',
            owner: 'acme',
            repo: 'widgets',
            number: 7,
        });
    });

    it('asks nothing for a titled issue, another tracker, or an unparsable reference', () => {
        expect(
            trackerPreviewRequest(artifact({ kind: 'issue', title: 'Fix login' })),
        ).toBeUndefined();
        expect(
            trackerPreviewRequest(
                artifact({ provider: 'linear', kind: 'issue', reference: 'ENG-123' }),
            ),
        ).toBeUndefined();
        expect(trackerPreviewRequest(artifact({ reference: 'widgets#7' }))).toBeUndefined();
    });
});

describe('trackerPreviewTitle', () => {
    it('returns the GitHub title', () => {
        expect(trackerPreviewTitle(githubPreview('Fix login redirect'))).toBe('Fix login redirect');
    });

    it('keeps the reference while loading, after a failure, or for a blank title', () => {
        expect(trackerPreviewTitle(undefined)).toBeUndefined();
        expect(trackerPreviewTitle({ kind: 'unavailable', reason: 'not-found' })).toBeUndefined();
        expect(trackerPreviewTitle(githubPreview('  '))).toBeUndefined();
    });
});
