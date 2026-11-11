import type { FileGrant, FileUse } from '/@/shared/types/file-access';

import { ipcRenderer, webUtils } from 'electron';

const selectAndAuthorize = (
    use: FileUse,
    filters?: Array<{ extensions: string[]; name: string }>,
): Promise<FileGrant | null> => {
    return ipcRenderer.invoke('files-select-and-authorize', { filters, use });
};

const authorizeDroppedFiles = async (files: File[], use: FileUse): Promise<FileGrant | null> => {
    const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter(
            (filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0,
        );
    if (paths.length === 0) return null;

    return ipcRenderer.invoke('files-authorize-dropped', { paths, use });
};

const authorizeLocalFiles = (paths: string[], use: FileUse): Promise<FileGrant | null> => {
    return ipcRenderer.invoke('files-authorize-tag-editor', { paths, use });
};

const releaseGrant = (grantId: string): Promise<boolean> => {
    return ipcRenderer.invoke('files-release-grant', grantId);
};

export const files = {
    authorizeDroppedFiles,
    authorizeLocalFiles,
    releaseGrant,
    selectAndAuthorize,
};

export type Files = typeof files;
