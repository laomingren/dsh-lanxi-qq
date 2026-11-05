/**
 * 冒烟测试：发布前最低限度验证（2026-11-03 补，P0-6）。
 * 覆盖：主入口 import 与导出形态、exports 子路径可解析、package.json 元信息。
 * 这些用例不连 NapCat、不起插件，只验证「装得上、导得出、名字对」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

describe('主入口 lib/index.js', () => {
    it('可 import 且导出完整', async () => {
        const mod = await import('../lib/index.js');
        expect(mod.name).toBe('dsh-lanxi-qq');
        expect(typeof mod.apply).toBe('function');
        expect(typeof mod.defaultMediaDir).toBe('function');
        expect(typeof mod.dshHome).toBe('function');
        expect(typeof mod.resolveDeprecatedConfig).toBe('function');
        // inject 声明必须包含 tools/systemPrompt/agents 等宿主面
        expect(Array.isArray(mod.inject)).toBe(true);
        expect(mod.inject).toContain('tools');
        expect(mod.inject).toContain('sessions');
    });

    it('Config schema 可构造且带默认值', async () => {
        const { Config } = await import('../lib/index.js');
        const parsed = Config({});
        // 抽查几个关键默认值（与 lib/index.js schema 一致）
        expect(parsed.mode).toBe('reverse');
        expect(parsed.port).toBe(8643);
        expect(parsed.accessToken).toBe('');
        expect(parsed.groupToolPolicy).toBe('inherit');
        expect(parsed.groupQuietWakeNames).toEqual([]);
        expect(parsed.bubbleSplit).toBe(false);
        expect(parsed.durableOutbox).toBe(true);
        // 2026-11-03 新增：语音同步听默认关闭
        expect(parsed.voiceEarPython).toBe('');
        expect(parsed.voiceEarScript).toBe('');
    });

    it('defaultMediaDir/dshHome 落在 ~/.dsh 下', async () => {
        const { defaultMediaDir, dshHome } = await import('../lib/index.js');
        expect(dshHome().length).toBeGreaterThan(0);
        expect(defaultMediaDir().startsWith(dshHome())).toBe(true);
        expect(defaultMediaDir()).toContain('onebot');
    });
});

describe('exports 子路径', () => {
    it('./settings-remote 可 import 且导出设置面', async () => {
        const mod = await import('../lib/settings-remote.js');
        expect(typeof mod.getSettings).toBe('function');
        expect(typeof mod.updateSettings).toBe('function');
        expect(typeof mod.createOnebotSettingsMethods).toBe('function');
        expect(mod.ENTRY_ID).toBe('dsh-lanxi-qq');
        expect(Array.isArray(mod.ALL_KEYS)).toBe(true);
        expect(mod.ALL_KEYS.length).toBeGreaterThan(0);
    });

    it('./package.json 元信息正确（版本号语义化、无 repository 占位）', () => {
        const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
        expect(pkg.name).toBe('dsh-lanxi-qq');
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkg.license).toBe('BSD-3-Clause');
        expect(pkg.main).toBe('lib/index.js');
        // P0-1：repository 不得再出现本机 file:// 占位（真实 GitHub 地址允许）
        expect(String(pkg.repository?.url ?? '')).not.toMatch(/^file:/);
        // P1-4：contributes 与 lib/tools.js 注册表对齐（10 个）
        expect(pkg.dshx.contributes.tools).toEqual([
            'qq_send_image',
            'qq_send_voice',
            'qq_send_video',
            'qq_send_file',
            'qq_send_forward',
            'qq_send_group_msg',
            'qq_no_reply',
            'qq_qzone_post',
            'qq_napcat_api',
            'qq_group_history',
        ]);
    });
});
