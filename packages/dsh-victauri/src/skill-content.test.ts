import { describe, expect, it } from 'vitest';
import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';

/** 与 @deepseek-ai/dsh-skill 的 isSkillName 同口径的 kebab-case 保守校验。 */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('victauri-fullstack-debug skill 内容', () => {
  it('skill 名是 kebab-case 且与注册名一致', () => {
    expect(SKILL_NAME).toBe('victauri-fullstack-debug');
    expect(SKILL_NAME).toMatch(KEBAB);
  });

  it('路由描述非空且点名 victauri 与调试场景', () => {
    expect(SKILL_DESCRIPTION.length).toBeGreaterThan(20);
    expect(SKILL_DESCRIPTION).toContain('victauri');
    expect(SKILL_DESCRIPTION).toContain('调试');
  });

  it('SOP 正文含关键套路章节（步骤化而非工具罗列）', () => {
    for (const section of [
      '环境确认',
      '后端验证三段式',
      '数据层取证',
      '契约健康',
      '故障注入配方',
      '窗口盲区排障',
    ]) {
      expect(SKILL_CONTENT, `缺失章节:${section}`).toContain(section);
    }
    // 关键陷阱必须写进正文（这些是审查中确认过的事实口径）
    expect(SKILL_CONTENT).toContain('backend_log_cursor');
    expect(SKILL_CONTENT).toContain('脱敏');
    expect(SKILL_CONTENT).toContain('victauri:default');
    expect(SKILL_CONTENT).toContain('%TEMP%\\dsh-victauri\\');
  });

  it('正文是 trim 后纯字符串（注册 API 要求非空 content）', () => {
    expect(SKILL_CONTENT).toBeTypeOf('string');
    expect(SKILL_CONTENT.length).toBeGreaterThan(500);
    expect(SKILL_CONTENT).toBe(SKILL_CONTENT.trim());
  });
});
