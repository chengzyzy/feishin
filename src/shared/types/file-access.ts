export interface FileGrant {
    grantId: string;
    paths: string[];
    use: FileUse;
}

export type FileUse = 'audio' | 'font' | 'image';
