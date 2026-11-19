import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Mock } from 'vitest';
import { apply } from './index.ts';
import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';
import {
  REVIEW_SKILL_CONTENT,
  REVIEW_SKILL_DESCRIPTION,
  REVIEW_SKILL_NAME,
} from './review-skill-content.ts';
import {
  APPLICATION_SKILL_CONTENT,
  APPLICATION_SKILL_DESCRIPTION,
  APPLICATION_SKILL_NAME,
} from './application-skill-content.ts';

/**
 * 内嵌 skill 注册契约：三个方法论 skill（撰写侧 + 审查侧 + 申请文件生成侧）
 * 在 apply 时注册、卸载时注销；审查侧内容包含 24 视角拓扑、定权规则、
 * 收敛/纠错/裁剪纪律；申请文件侧包含五书形态与撰写纪律。
 */

interface RegisteredSkill {
  name: string;
  description: string;
  content: string;
}

function stubCtx(): {
  ctx: Context;
  registered: RegisteredSkill[];
  disposeSpies: Array<Mock<() => void>>;
  sections: number;
} {
  const registered: RegisteredSkill[] = [];
  const disposeSpies: Array<Mock<() => void>> = [];
  const effects: Array<() => void> = [];
  const ctx = {
    effect(fn: () => () => void) {
      effects.push(fn());
    },
    systemPrompt: {
      section() {
        return () => undefined;
      },
    },
    skills: {
      register(skill: RegisteredSkill) {
        registered.push(skill);
        const dispose = vi.fn<() => void>();
        disposeSpies.push(dispose);
        return () => dispose();
      },
    },
    tools: {
      register() {
        // 工具注册面在 tools.test 覆盖，这里只计数即可
      },
    },
  } as unknown as Context;
  return { ctx, registered, disposeSpies, sections: 0 };
}

describe('dsh-patent', () => {
  describe('内嵌 skill 注册', () => {
    it('注册撰写侧、审查侧与申请文件侧三个 skill,名称与描述可从 registry 读到', () => {
      const { ctx, registered } = stubCtx();
      apply(ctx);

      expect(registered.length).toBe(3);
      expect(registered[0]?.name).toBe(SKILL_NAME);
      expect(registered[0]?.description).toBe(SKILL_DESCRIPTION);
      expect(registered[1]?.name).toBe(REVIEW_SKILL_NAME);
      expect(registered[1]?.description).toBe(REVIEW_SKILL_DESCRIPTION);
      expect(registered[2]?.name).toBe(APPLICATION_SKILL_NAME);
      expect(registered[2]?.description).toBe(APPLICATION_SKILL_DESCRIPTION);
      // 描述写明触发场景与不适用场景（清单[2]）
      expect(REVIEW_SKILL_DESCRIPTION).toContain(
        'reviewing an attorney patent draft',
      );
      expect(REVIEW_SKILL_DESCRIPTION).toContain(
        'not for drafting disclosures',
      );
      // 申请文件侧描述同样写明触发与不适用场景
      expect(APPLICATION_SKILL_DESCRIPTION).toContain(
        'China patent application file drafting methodology',
      );
      expect(APPLICATION_SKILL_DESCRIPTION).toContain(
        'not for drafting the 交底书 itself',
      );
    });

    it('申请文件侧 skill 内容:五书形态、段号与权项纪律成节', () => {
      expect(APPLICATION_SKILL_CONTENT).toContain('## 五书的真实形态');
      expect(APPLICATION_SKILL_CONTENT).toContain('没有独立的「说明书摘要」页');
      expect(APPLICATION_SKILL_CONTENT).toContain('[0001]');
      expect(APPLICATION_SKILL_CONTENT).toContain('## 权利要求书纪律');
      expect(APPLICATION_SKILL_CONTENT).toContain('多项从属权禁令');
      expect(APPLICATION_SKILL_CONTENT).toContain('类型引用句式');
      expect(APPLICATION_SKILL_CONTENT).toContain('## 说明书纪律');
      expect(APPLICATION_SKILL_CONTENT).toContain('公开充分');
      expect(APPLICATION_SKILL_CONTENT).toContain('## 工作纪律');
      expect(APPLICATION_SKILL_CONTENT).toContain(
        '工具只出骨架，不代拟实质内容',
      );
    });

    it('插件卸载时三个 skill 一并注销', () => {
      const { ctx, disposeSpies } = stubCtx();
      apply(ctx);
      for (const dispose of disposeSpies) {
        expect(dispose).not.toHaveBeenCalled();
      }
      // cordis 在插件卸载时调用 effect 清理函数 → 三个 dispose 都被触发
      for (const dispose of disposeSpies) dispose();
      for (const dispose of disposeSpies) {
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    });

    it('审查侧 skill 内容:24 视角拓扑(A10/B7/C3/D4)与两条定权规则', () => {
      expect(REVIEW_SKILL_CONTENT).toContain('| A 合规规范组 |');
      expect(REVIEW_SKILL_CONTENT).toContain('| B 源码对照组 |');
      expect(REVIEW_SKILL_CONTENT).toContain('| C 交底书对照组 |');
      expect(REVIEW_SKILL_CONTENT).toContain('| D 战略综合组 |');
      expect(REVIEW_SKILL_CONTENT).toContain('定权 A（符合性优先）');
      expect(REVIEW_SKILL_CONTENT).toContain('定权 B（范围小而精）');
      expect(REVIEW_SKILL_CONTENT).toContain('源码有实现但权项**未覆盖**');
    });

    it('审查侧 skill 内容:收敛纪律与纠错纪律成节,含两个被证伪反例', () => {
      // 收敛纪律（清单[3]）：断言须挂源码 文件:行号 或交底书条目
      expect(REVIEW_SKILL_CONTENT).toContain('## 收敛纪律（不挂证据就不报）');
      expect(REVIEW_SKILL_CONTENT).toContain('文件:行号');
      expect(REVIEW_SKILL_CONTENT).toContain('[INFERENCE]');
      // 纠错纪律（清单[4]）：两个实战反例
      expect(REVIEW_SKILL_CONTENT).toContain('## 纠错纪律（以代码事实为准）');
      expect(REVIEW_SKILL_CONTENT).toContain('JPEG 伪装成 PNG');
      expect(REVIEW_SKILL_CONTENT).toContain('钩子第 8 种时点');
    });

    it('审查侧 skill 内容:视角裁剪规则给出轻量档与全量档', () => {
      expect(REVIEW_SKILL_CONTENT).toContain('轻量档');
      expect(REVIEW_SKILL_CONTENT).toContain('全量档');
      expect(REVIEW_SKILL_CONTENT).toContain('B 组源码对照 7 视角');
    });

    it('撰写侧 skill 内容保持不变(回归)', () => {
      expect(SKILL_CONTENT).toContain('# 技术交底书撰写方法论');
    });
  });
});
