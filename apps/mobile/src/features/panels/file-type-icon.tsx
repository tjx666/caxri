import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import type { FileEntry } from '@caxri/protocol';
import { ArrowUpRight } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { fileIconSvg, resolveFileIconId } from './file-icon';
import { panelsStyles as styles } from './panels-styles';

/**
 * The vscode-icons artwork Desktop's Files explorer uses. A symlink wears a small arrow badge on top of whichever icon
 * its target resolved to, matching Desktop's `FileTypeIcon`.
 */
export const FileTypeIcon = ({
    entry,
    size = 20,
    theme,
}: {
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>;
    size?: number;
    theme: MobileTheme;
}) => (
    <View style={{ height: size, width: size }}>
        <SvgXml height={size} width={size} xml={fileIconSvg(resolveFileIconId(entry))} />
        {entry.kind === 'symlink' ? (
            <View style={[styles.symlinkBadge, { backgroundColor: theme.background }]}>
                <ArrowUpRight color={theme.text} size={9} strokeWidth={3} />
            </View>
        ) : null}
    </View>
);
