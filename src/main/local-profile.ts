import { app } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
    if (metadata.name === 'feishin-local') {
        // 更换显示名称时沿用已有服务器和播放器配置，显式指定的测试目录优先。
        const profilePath = join(app.getPath('appData'), 'Feishin Local');
        mkdirSync(profilePath, { recursive: true });
        app.setPath('userData', profilePath);
    }
}
