import { useMemo } from 'react';

import { translate, useTranslation } from './i18n';

function describe(t: typeof translate): string {
    return t('common.close');
}

export function DirectCall() {
    return <span>{translate('common.close')}</span>;
}

export function PassedAsArgument() {
    return <span>{describe(translate)}</span>;
}

export function InsideArrayCallback({ keys }: { keys: Array<'common.close'> }) {
    return <span>{keys.map((key) => translate(key)).join(',')}</span>;
}

export function useMemoizedLabel() {
    return useMemo(() => translate('common.close'), []);
}

export function EventHandlerIsFine() {
    return <button onClick={() => alert(translate('common.close'))} type="button" />;
}

export function HookProvidedTranslateIsFine() {
    const { t } = useTranslation();
    return <span>{describe(t)}</span>;
}

export function plainHelperIsFine(): string {
    return translate('common.close');
}
