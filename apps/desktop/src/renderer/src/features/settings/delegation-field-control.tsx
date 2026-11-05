import type { AppSettings, IntegerSettingSpec } from '@caxri/protocol';
import {
    DEFAULT_DELEGATION_DEPTH,
    MAX_DELEGATION_DEPTH,
    MIN_DELEGATION_DEPTH,
} from '@caxri/protocol';

import { Switch } from '../../components/ui/switch';
import { IntegerControl } from './integer-control';

/**
 * `agents.delegation` is one complex value, so its depth has no entry in `settingsSpecByKey` to render from. The bounds
 * come from the schema that validates the write, not from numbers retyped here, so the control can never offer a value
 * the write would reject.
 */
const DELEGATION_DEPTH_SPEC: IntegerSettingSpec = {
    kind: 'integer',
    key: 'agents.delegation',
    title: 'Delegation depth',
    category: 'agents',
    min: MIN_DELEGATION_DEPTH,
    max: MAX_DELEGATION_DEPTH,
    default: DEFAULT_DELEGATION_DEPTH,
};

type DelegationSettings = AppSettings['agents.delegation'];

/**
 * The on/off fields of `agents.delegation`, each rendered as one switch.
 */
type DelegationSwitchField = 'approval' | 'autoHandBack' | 'readChildChat';

interface DelegationFieldControlProperties {
    id: string;
    label: string;
    field: DelegationSwitchField | 'maxDepth';
    value: DelegationSettings;
    /**
     * Receives the whole value with only `field` changed, so the presets and caller bindings the user hand-wrote
     * survive the write.
     */
    onChange: (value: DelegationSettings, member: string) => void;
}

/**
 * The control of one scalar field of `agents.delegation`.
 */
export function DelegationFieldControl({
    id,
    label,
    field,
    value,
    onChange,
}: DelegationFieldControlProperties) {
    if (field !== 'maxDepth')
        return (
            <Switch
                id={id}
                aria-label={label}
                checked={value[field]}
                className="mt-0.5"
                onCheckedChange={(checked) => onChange({ ...value, [field]: checked }, field)}
            />
        );
    return (
        <IntegerControl
            id={id}
            label={label}
            spec={DELEGATION_DEPTH_SPEC}
            value={value.maxDepth}
            onChange={(maxDepth) => onChange({ ...value, maxDepth }, 'maxDepth')}
        />
    );
}
