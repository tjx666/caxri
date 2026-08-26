import type { IntegerSettingSpec } from '@shared/config';

import { Input } from '../../components/ui/input';

interface IntegerControlProperties {
    id: string;
    label: string;
    spec: IntegerSettingSpec;
    value: number;
    onChange: (value: number) => void;
}

/**
 * Number field with the unit rendered inside the field (DESIGN.md: byte values appear as human units with a unit-aware
 * input). `display.scale` converts between the stored integer and the edited unit, e.g. bytes on disk, mebibytes on
 * screen.
 */
export function IntegerControl({ id, label, spec, value, onChange }: IntegerControlProperties) {
    const scale = spec.display?.scale ?? 1;
    const shown = scale === 1 ? value : value / scale;
    return (
        <span className="relative w-40 flex-none">
            <Input
                id={id}
                aria-label={label}
                className="bg-background pr-12"
                type="number"
                min={spec.min / scale}
                max={spec.max / scale}
                step={spec.display?.step ?? 1}
                value={shown}
                onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isNaN(next)) return;
                    onChange(scale === 1 ? next : Math.round(next * scale));
                }}
            />
            {spec.display?.unit && (
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                    {spec.display.unit}
                </span>
            )}
        </span>
    );
}
