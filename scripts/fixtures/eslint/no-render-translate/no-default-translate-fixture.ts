import { translate } from './i18n';
import type { Translate } from './i18n';

export function parameterDefault(t: Translate = translate): string {
    return t('common.close');
}

export function destructuredDefault({ t = translate }: { t?: Translate }): string {
    return t('common.close');
}

export function fallbackOperator(options: { t?: Translate }): string {
    const t = options.t ?? translate;
    return t('common.close');
}

export function requiredParameterIsFine(t: Translate): string {
    return t('common.close');
}

export function explicitEntryPointIsFine(): string {
    return requiredParameterIsFine(translate);
}
