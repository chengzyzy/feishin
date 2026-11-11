import type {
    ArtworkOp,
    ReadSongMetadataBatchResult,
    TagValue,
    WriteSongTagsBatchResult,
} from '/@/shared/types/tag-editor';

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { isTrustedIpcSender } from '../../../index';
import { fileGrants } from '../../../security/file-grants';
import { validateGrantedFiles } from '../../../security/file-policy';
import { readFilesMetadataBatch, readLocalImageFile, writeFilesTags } from './taglib-service';

const sendBatchProgress = (event: IpcMainInvokeEvent, processed: number, total: number) => {
    event.sender.send('batch-progress', { processed, total });
};

let activeReadController: AbortController | null = null;

ipcMain.handle('cancel-read-song-metadata', (event) => {
    if (!isTrustedIpcSender(event)) return;
    activeReadController?.abort();
    activeReadController = null;
});

ipcMain.handle(
    'read-song-metadata-batch',
    async (event, grantId: unknown): Promise<ReadSongMetadataBatchResult> => {
        if (!isTrustedIpcSender(event)) {
            return { artworkKind: 'none', success: false };
        }

        const grant = fileGrants.resolve(grantId, 'audio', event.sender.id);
        if (!grant) {
            return {
                artworkKind: 'none',
                error: 'Local audio file access was not authorized',
                success: false,
            };
        }
        const filePaths = grant.paths;

        activeReadController?.abort();
        activeReadController = new AbortController();
        const { signal } = activeReadController;

        try {
            const result = await readFilesMetadataBatch(
                filePaths,
                (processed, total) => sendBatchProgress(event, processed, total),
                signal,
            );

            if (signal.aborted) {
                return { artworkKind: 'none', success: false };
            }

            if (!result.success) {
                return {
                    artworkKind: 'none',
                    error: result.failedFiles[0]?.error ?? 'No readable audio files in selection',
                    failedFiles: result.failedFiles,
                    readCount: result.readCount,
                    success: false,
                    totalCount: result.totalCount,
                };
            }

            return {
                artworkKind: result.artworkKind,
                failedFiles: result.failedFiles.length > 0 ? result.failedFiles : undefined,
                fileArtwork: result.fileArtwork,
                fileTags: result.fileTags,
                multiValueKeys: result.multiValueKeys,
                readCount: result.readCount,
                success: true,
                tagSummary: result.tagSummary,
                totalCount: result.totalCount,
                ...(result.artworkData
                    ? {
                          artworkData: result.artworkData,
                          artworkMimeType: result.artworkMimeType,
                      }
                    : {}),
            };
        } catch (err) {
            return { artworkKind: 'none', error: String(err), success: false };
        } finally {
            activeReadController = null;
        }
    },
);

ipcMain.handle(
    'write-song-tags-batch',
    async (
        event,
        grantId: unknown,
        requestedPaths: unknown,
        edits: Record<string, TagValue>,
        removed: string[],
        artworkOp?: ArtworkOp,
    ): Promise<WriteSongTagsBatchResult> => {
        if (!isTrustedIpcSender(event)) {
            return { error: 'Untrusted renderer', success: false };
        }

        const grant = fileGrants.resolve(grantId, 'audio', event.sender.id);
        if (!grant) {
            return { error: 'Local audio file access was not authorized', success: false };
        }
        const filePaths = await validateGrantedFiles(requestedPaths, grant.paths, 'audio');
        if (!filePaths) {
            return { error: 'Selected audio files are outside the grant', success: false };
        }

        try {
            const result = await writeFilesTags(
                filePaths,
                edits,
                removed,
                artworkOp,
                (processed, total) => sendBatchProgress(event, processed, total),
            );

            if (!result.success) {
                return {
                    error: result.failedFiles[0]?.error,
                    failedFiles: result.failedFiles,
                    success: false,
                };
            }
            return { success: true };
        } catch (err) {
            return { error: String(err), success: false };
        }
    },
);

ipcMain.handle('read-local-image', async (event, grantId: unknown) => {
    if (!isTrustedIpcSender(event)) {
        return { error: 'Untrusted renderer', success: false };
    }

    const grant = fileGrants.resolve(grantId, 'image', event.sender.id);
    if (!grant || !grant.paths[0]) {
        return { error: 'Local image access was not authorized', success: false };
    }

    try {
        const { data, mimeType } = await readLocalImageFile(grant.paths[0]);
        return { data, mimeType, success: true };
    } catch (err) {
        return { error: String(err), success: false };
    }
});
