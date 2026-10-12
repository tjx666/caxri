import { afterEach, describe, expect, it } from 'vitest';

import { useLocaleStore } from '../../../i18n';
import { viewContainerTitle, viewPresentation, viewTitle } from '../view-container-labels';

const gitPresentation = {
    actionErrorMessage: 'Git action failed',
    loadingMessage: 'Loading Git status…',
    noContextMessage: 'Pick a Session to inspect its Git state.',
    refreshErrorMessage: 'Git refresh failed',
};

describe('view container labels', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('keeps the English catalog wording for built-in ids', () => {
        useLocaleStore.setState({ locale: 'en' });
        expect(viewContainerTitle({ id: 'caxri.files', title: 'Files' })).toBe('Files');
        expect(viewTitle({ id: 'caxri.git.sourceControl', title: 'Source Control' })).toBe(
            'Source Control',
        );
        expect(viewPresentation('caxri.git.sourceControl', gitPresentation)).toEqual(
            gitPresentation,
        );
    });

    it('translates built-in ids and leaves extension titles as provided', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(viewContainerTitle({ id: 'caxri.project-status', title: 'Status' })).toBe('状态');
        expect(viewTitle({ id: 'caxri.git.sourceControl', title: 'Source Control' })).toBe(
            '源代码管理',
        );
        expect(viewContainerTitle({ id: 'caxri.git', title: 'Git' })).toBe('Git');
        expect(viewContainerTitle({ id: 'acme.tools', title: 'Tools' })).toBe('Tools');
        const custom = { ...gitPresentation, loadingMessage: 'Loading…' };
        expect(viewPresentation('acme.tools.view', custom)).toBe(custom);
    });
});
