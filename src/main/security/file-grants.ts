import type { FileGrant, FileUse } from '/@/shared/types/file-access';

import { randomUUID } from 'node:crypto';

interface OwnedFileGrant extends FileGrant {
    webContentsId: number;
}

/**
 * Grants are the only way tag editor and image IPC readers learn about
 * local paths. A grant is created from a native dialog selection or from a real File
 * object resolved in preload and released when the editor or its window closes.
 */
export class FileGrantRegistry {
    private readonly grants = new Map<string, OwnedFileGrant>();

    create(use: FileUse, paths: string[], webContentsId: number): FileGrant {
        const grantId = randomUUID();
        this.grants.set(grantId, { grantId, paths: [...paths], use, webContentsId });
        return { grantId, paths: [...paths], use };
    }

    resolve(grantId: unknown, use: FileUse, webContentsId: number): FileGrant | null {
        if (typeof grantId !== 'string') return null;
        const grant = this.grants.get(grantId);
        if (!grant || grant.use !== use || grant.webContentsId !== webContentsId) return null;
        return { grantId: grant.grantId, paths: [...grant.paths], use: grant.use };
    }

    revoke(grantId: string, webContentsId: number): boolean {
        if (this.grants.get(grantId)?.webContentsId !== webContentsId) return false;
        return this.grants.delete(grantId);
    }

    revokeForWebContents(webContentsId: number): void {
        for (const [id, grant] of this.grants) {
            if (grant.webContentsId === webContentsId) this.grants.delete(id);
        }
    }
}

export const fileGrants = new FileGrantRegistry();
