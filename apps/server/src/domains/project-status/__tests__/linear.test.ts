import { describe, expect, it } from 'vitest';

import { collectLinearCandidates } from '../linear';

const teamKeys = new Set(['ABC', 'XYZ']);

describe('Linear issue candidate collection', () => {
    it('leads with the pull request description, then the branch, then the conversation', () => {
        expect(
            collectLinearCandidates({
                branch: 'feat/xyz-7-router',
                conversation: [{ identifier: 'ABC-9' }],
                pullRequestBody: 'Fixes ABC-1',
                teamKeys,
            }),
        ).toEqual([
            { identifier: 'ABC-1', source: 'pull-request' },
            { identifier: 'XYZ-7', source: 'branch' },
            { identifier: 'ABC-9', source: 'conversation' },
        ]);
    });

    it('keeps the first source that named an issue rather than repeating or demoting it', () => {
        expect(
            collectLinearCandidates({
                branch: 'feat/abc-1-router',
                conversation: [{ identifier: 'ABC-1' }],
                pullRequestBody: 'Fixes ABC-1',
                teamKeys,
            }),
        ).toEqual([{ identifier: 'ABC-1', source: 'pull-request' }]);
    });

    it('reads the identifier out of a Linear-generated branch name, slug and all', () => {
        expect(
            collectLinearCandidates({ branch: 'feat/abc-13990-router-monitoring', teamKeys }),
        ).toEqual([{ identifier: 'ABC-13990', source: 'branch' }]);
    });

    it('rejects markers whose team key the workspace does not define', () => {
        expect(
            collectLinearCandidates({
                branch: 'fix/utf-8-decoding',
                conversation: [
                    { identifier: 'RFC-2119' },
                    { identifier: 'CVE-2024' },
                    { identifier: 'ABC-3' },
                ],
                teamKeys,
            }),
        ).toEqual([{ identifier: 'ABC-3', source: 'conversation' }]);
    });

    it('contributes nothing from the low-precision sources when the allow-list is unknown', () => {
        expect(
            collectLinearCandidates({
                branch: 'feat/abc-1-router',
                conversation: [{ identifier: 'ABC-9' }],
                teamKeys: new Set(),
            }),
        ).toEqual([]);
    });

    it('admits a conversation reference whose own linear.app URL proved its workspace', () => {
        expect(
            collectLinearCandidates({
                conversation: [{ identifier: 'QQQ-5', workspace: 'Acme' }],
                teamKeys: new Set(),
            }),
        ).toEqual([{ identifier: 'QQQ-5', source: 'conversation', workspace: 'acme' }]);
    });

    it('caps how many issues one branch may lead with', () => {
        expect(
            collectLinearCandidates({
                conversation: [
                    { identifier: 'ABC-1' },
                    { identifier: 'ABC-2' },
                    { identifier: 'ABC-3' },
                    { identifier: 'ABC-4' },
                    { identifier: 'ABC-5' },
                ],
                teamKeys,
            }),
        ).toHaveLength(4);
    });
});
