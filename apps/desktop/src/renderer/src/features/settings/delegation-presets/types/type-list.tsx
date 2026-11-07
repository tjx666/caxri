import type { AppSettings } from '@caxri/protocol';
import { DELEGATION_TYPES } from '@caxri/protocol';

import { useTranslation } from '../../../../i18n';
import { TypeRow } from './type-row';

type DelegationSettings = AppSettings['agents.delegation'];

/**
 * The tasks an Agent can ask for with `agent delegate create --type`: which Agent, model and effort each runs on (the
 * built-in default until the user binds one), and per calling Agent overrides. Edits hand the whole `agents.delegation`
 * value to `onChange`, the Settings page's own write path.
 */
export function TypeList({
    value,
    onChange,
}: {
    value: DelegationSettings;
    onChange: (value: DelegationSettings, member: string) => void;
}) {
    const { t } = useTranslation();
    return (
        <ul
            aria-label={t('settings.delegationTypes.title')}
            className="m-0 flex list-none flex-col gap-1 p-0"
        >
            {DELEGATION_TYPES.map((type) => (
                <TypeRow key={type} type={type} value={value} onChange={onChange} />
            ))}
        </ul>
    );
}
