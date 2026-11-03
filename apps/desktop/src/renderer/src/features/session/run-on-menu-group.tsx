import type { ProjectRecord } from '@caxri/protocol';

import {
    MenuGroup,
    MenuGroupLabel,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
} from '../../components/ui/menu';
import { useTranslation } from '../../i18n';
import { environmentOfProject } from '../../lib/environment-routing';
import { hostDisplayOf, useHostPreference } from '../../stores/host-preferences';
import { HostGlyph } from '../ssh-host/host-glyph';

/**
 * One machine in the Run on choice of a Project that lives on several.
 */
function RunOnChoice({ member }: { member: ProjectRecord }) {
    const environmentId = environmentOfProject(member.id);
    const preference = useHostPreference(environmentId);
    const host = hostDisplayOf(environmentId, preference);
    return (
        <MenuRadioItem closeOnClick={false} value={member.id}>
            <span className="text-muted">
                <HostGlyph icon={host.icon} size={14} system={host.system} />
            </span>
            <span className="flex-1 truncate">{host.name}</span>
        </MenuRadioItem>
    );
}

/**
 * The New Session menu's first choice for a repository checked out on several machines: which machine's checkout the
 * Session runs in.
 */
export function RunOnMenuGroup({
    members,
    value,
    onValueChange,
}: {
    members: readonly ProjectRecord[];
    value: string;
    onValueChange: (projectId: string) => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <MenuGroup>
                <MenuGroupLabel>{t('session.create.runOn')}</MenuGroupLabel>
                <MenuRadioGroup
                    value={value}
                    onValueChange={(next: unknown) => {
                        if (typeof next === 'string') onValueChange(next);
                    }}
                >
                    {members.map((member) => (
                        <RunOnChoice key={member.id} member={member} />
                    ))}
                </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
        </>
    );
}
