import { readFileSync } from 'node:fs';

import type * as CaxriModule from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { localizeServerStatusText } from '../status-server-text';

const chinese = JSON.parse(
    readFileSync(new URL('../../l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'),
) as Record<string, string>;

vi.mock('caxri', async (importOriginal) => {
    const actual = await importOriginal<typeof CaxriModule>();
    return { ...actual, l10n: actual.createL10n(() => chinese) };
});

describe('localizeServerStatusText', () => {
    it('renders a recognized Server sentence through the bundle with its values', () => {
        expect(localizeServerStatusText('GitHub CLI not signed in')).toBe(
            chinese['{provider} not signed in'].replace('{provider}', 'GitHub CLI'),
        );
        expect(
            localizeServerStatusText(
                'Caxri paused GitHub checks to protect the shared API budget. Retries after 14:05.',
            ),
        ).toBe(
            chinese[
                'Caxri paused {service} checks to protect the shared API budget. Retries after {time}.'
            ]
                .replace('{service}', 'GitHub')
                .replace('{time}', '14:05'),
        );
    });

    it('passes through a sentence it does not recognize', () => {
        expect(localizeServerStatusText('Build failed')).toBe('Build failed');
        expect(localizeServerStatusText('gh: unexpected token')).toBe('gh: unexpected token');
    });
});
