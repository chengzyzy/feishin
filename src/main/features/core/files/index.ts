import type { FileUse } from '/@/shared/types/file-access';

import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';

import { isTrustedIpcSender } from '../../../index';
import { fileGrants } from '../../../security/file-grants';
import { isFileUse, validateReadableFiles } from '../../../security/file-policy';

const sanitizeFilters = (filters: unknown) => {
    if (!Array.isArray(filters)) return undefined;
    return filters
        .flatMap((filter) => {
            if (!filter || typeof filter !== 'object') return [];
            const candidate = filter as { extensions?: unknown; name?: unknown };
            if (
                !Array.isArray(candidate.extensions) ||
                !candidate.extensions.every((extension) => typeof extension === 'string') ||
                typeof candidate.name !== 'string'
            ) {
                return [];
            }
            return [{ extensions: candidate.extensions, name: candidate.name }];
        })
        .slice(0, 8);
};

const createGrant = async (use: FileUse, paths: string[], webContentsId: number) => {
    const validated = await validateReadableFiles(paths, use);
    if (!validated.ok || !validated.paths) return null;
    return fileGrants.create(use, validated.paths, webContentsId);
};

ipcMain.handle('files-select-and-authorize', async (event, data?: Record<string, unknown>) => {
    if (!isTrustedIpcSender(event) || !isFileUse(data?.use)) return null;

    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: OpenDialogOptions = {
        filters: sanitizeFilters(data.filters),
        properties: data.use === 'audio' ? ['openFile', 'multiSelections'] : ['openFile'],
    };
    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;

    return createGrant(data.use, result.filePaths, event.sender.id);
});

ipcMain.handle('files-authorize-dropped', async (event, data?: Record<string, unknown>) => {
    if (!isTrustedIpcSender(event) || !isFileUse(data?.use)) return null;
    if (!Array.isArray(data.paths) || data.paths.length === 0) return null;
    if (!data.paths.every((candidate) => typeof candidate === 'string')) return null;

    return createGrant(data.use, data.paths, event.sender.id);
});

ipcMain.handle('files-authorize-tag-editor', async (event, data?: Record<string, unknown>) => {
    if (!isTrustedIpcSender(event) || !isFileUse(data?.use)) return null;
    if (!Array.isArray(data.paths) || data.paths.length === 0) return null;
    if (!data.paths.every((candidate) => typeof candidate === 'string')) return null;

    const validated = await validateReadableFiles(data.paths, data.use);
    if (!validated.ok || !validated.paths) return null;

    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const visibleFiles = validated.paths
        .slice(0, 5)
        .map((filePath) => filePath)
        .join('\n');
    const messageBoxOptions = {
        buttons: ['Cancel', 'Allow'],
        cancelId: 0,
        defaultId: 0,
        detail:
            validated.paths.length > 5
                ? `${visibleFiles}\n... and ${validated.paths.length - 5} more`
                : visibleFiles,
        message: `Allow Feishin to read and edit tags for ${validated.paths.length} local file(s)?`,
        noLink: true,
        type: 'question' as const,
    };
    const confirmation = parentWindow
        ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
        : await dialog.showMessageBox(messageBoxOptions);

    if (confirmation.response !== 1) return null;
    return fileGrants.create(data.use, validated.paths, event.sender.id);
});

ipcMain.handle('files-release-grant', (event, grantId: unknown) => {
    if (!isTrustedIpcSender(event) || typeof grantId !== 'string') return false;
    return fileGrants.revoke(grantId, event.sender.id);
});

app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => fileGrants.revokeForWebContents(contents.id));
});
