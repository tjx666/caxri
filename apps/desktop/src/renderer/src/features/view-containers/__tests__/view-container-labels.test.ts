import { afterEach, describe, expect, it } from 'vitest';

import { translate, useLocaleStore } from '../../../i18n';
import { viewContainerTitle, viewTitle } from '../view-container-labels';

describe('view container labels', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('keeps the English catalog wording for built-in ids', () => {
        useLocaleStore.setState({ locale: 'en' });
        expect(viewContainerTitle({ id: 'caxri.files', title: 'Files' }, translate)).toBe('Files');
        expect(viewTitle({ id: 'caxri.logs.view', title: 'Logs' }, translate)).toBe('Logs');
    });

    it('translates built-in ids and leaves extension titles as provided', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(viewContainerTitle({ id: 'caxri.info', title: 'Info' }, translate)).toBe(
            translate('viewContainers.builtin.info'),
        );
        expect(viewContainerTitle({ id: 'caxri.info', title: 'Info' }, translate)).not.toBe('Info');
        // Bundled extensions arrive already localized through their manifest, so their ids get no special case.
        expect(viewContainerTitle({ id: 'caxri.project-status', title: '状态' }, translate)).toBe(
            '状态',
        );
        expect(
            viewTitle({ id: 'caxri.git.sourceControl', title: 'Source Control' }, translate),
        ).toBe('Source Control');
        expect(viewContainerTitle({ id: 'acme.tools', title: 'Tools' }, translate)).toBe('Tools');
    });
});
