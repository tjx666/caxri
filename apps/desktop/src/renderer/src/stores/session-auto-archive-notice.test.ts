import type { BootstrapState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { describeSessionAutoArchive } from './session-auto-archive-notice';

function bootstrap(title: string): BootstrapState {
    return { sessions: [{ id: 's1', title }] } as unknown as BootstrapState;
}

describe('describeSessionAutoArchive', () => {
    it('names the Session and the merge, and offers an Undo that restores in place', () => {
        const { action, message } = describeSessionAutoArchive(
            { sessionId: 's1', pullRequestState: 'merged' },
            bootstrap('api-fix'),
        );

        expect(message).toBe('Archived "api-fix" because its pull request was merged');
        expect(action).toMatchObject({ id: 'session.unarchive', params: { sessionId: 's1' } });
    });

    it('words a closed-not-merged pull request differently', () => {
        expect(
            describeSessionAutoArchive(
                { sessionId: 's1', pullRequestState: 'closed' },
                bootstrap('api-fix'),
            ).message,
        ).toBe('Archived "api-fix" because its pull request was closed');
    });

    it('falls back to the noun when the Session is not in the snapshot', () => {
        expect(
            describeSessionAutoArchive({ sessionId: 's1', pullRequestState: 'merged' }, undefined)
                .message,
        ).toBe('Archived Session because its pull request was merged');
    });
});
