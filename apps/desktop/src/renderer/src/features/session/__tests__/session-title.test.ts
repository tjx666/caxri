import { DEFAULT_SESSION_TITLE } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { sessionTitleForDisplay } from '../session-title';

const t: Translate = (key) => (key === 'session.untitled' ? '未命名' : key);

describe('sessionTitleForDisplay', () => {
    it('translates the stored placeholder of an unnamed Session', () => {
        expect(sessionTitleForDisplay(DEFAULT_SESSION_TITLE, t)).toBe('未命名');
    });

    it('shows every real title unchanged', () => {
        expect(sessionTitleForDisplay('Fix login', t)).toBe('Fix login');
        expect(sessionTitleForDisplay('untitled', t)).toBe('untitled');
    });
});
