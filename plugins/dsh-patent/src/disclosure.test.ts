import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildDisclosure, resolveBuiltinTemplatePath } from './disclosure.ts';

const FULL_INPUT = {
  header: {
    caseName: '车载充电桩在线升级方法',
    applicationType: '发明' as const,
    internalNo: 'N2026-001',
    applicant: '某某科技有限公司',
    inventors: '张三、李四',
    contactName: '张三',
    contactPhone: '13800000000',
    contactEmail: 'zhangsan@example.com',
    published: '否' as const,
  },
  sections: {
    background: ['现有充电桩固件升级需要停机现场操作。'],
    problems: { main: '升级效率低', minor: ['现场成本高'] },
    solution: ['通过蓝牙通信通道下发差分升级包，后台校验后原子切换。'],
    alternatives: ['升级通道可由蓝牙替换为 Wi-Fi。'],
    effects: ['无需停机，升级时间从 2 小时缩短到 10 分钟。'],
    protectionPoints: ['差分升级包的原子切换机制。'],
    figureNotes: ['图1：系统整体框图'],
  },
};

describe('dsh-patent', () => {
  describe('resolveBuiltinTemplatePath', () => {
    it('指向包内 assets 且文件真实存在', () => {
      const path = resolveBuiltinTemplatePath();
      expect(path).toContain('assets');
      expect(path).toContain('disclosure-template.docx');
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('buildDisclosure', () => {
    it('完整输入：七部分齐全、头部字段用真实值', () => {
      const result = buildDisclosure(FULL_INPUT);
      const order = [
        '## 一、背景技术',
        '## 二、背景技术的技术问题',
        '## 三、本案的详细阐述',
        '## 四、第三项的技术方案中有无可以替代的地方',
        '## 五、第三项的技术手段产生了什么技术效果',
        '## 六、本案需要保护的要点',
        '## 七、附图要求',
      ];
      const lines = result.markdown.split('\n');
      let pos = -1;
      for (const section of order) {
        const at = lines.findIndex((line, i) => i > pos && line === section);
        expect(at, `章节 ${section} 应存在`).toBeGreaterThan(pos);
        pos = at;
      }
      expect(result.markdown).toContain('车载充电桩在线升级方法');
      expect(result.markdown).toContain('某某科技有限公司');
      expect(result.markdown).not.toContain('〔');
      expect(result.issues).toEqual([]);
    });

    it('技术问题分主次编号输出', () => {
      const result = buildDisclosure(FULL_INPUT);
      expect(result.markdown).toContain(
        '**1.最主要、最关键的技术问题：** 升级效率低',
      );
      expect(result.markdown).toContain('**2.次要问题：** (1) 现场成本高');
    });

    it('缺省字段全部落占位并提示填写', () => {
      const result = buildDisclosure({ header: { caseName: '测试方法' } });
      expect(result.markdown).toContain('〔申请人：请填写公司名称〕');
      expect(result.markdown).toContain('〔发明人：请填写〕');
      expect(result.markdown).toContain('〔是/否，二选一〕');
      expect(result.markdown).toContain('〔待填写：');
    });

    it('空输入产出纯骨架并附 CONTENT_EMPTY 诊断', () => {
      const result = buildDisclosure({});
      expect(
        result.issues.some((i) => i.code === 'DISCLOSURE_CONTENT_EMPTY'),
      ).toBe(true);
      expect(result.markdown).toContain('## 三、本案的详细阐述');
    });

    it('builtin-docx 交付指引携带内置模板路径', () => {
      const result = buildDisclosure({ delivery: 'builtin-docx' });
      expect(result.deliveryGuide).toContain(result.templatePath);
      expect(result.deliveryGuide).toContain('doc.tables[0..5]');
    });

    it('user-docx 交付指引携带用户模板路径；缺失时报诊断', () => {
      const withPath = buildDisclosure({
        delivery: 'user-docx',
        userTemplatePath: 'E:\\tmpl\\my-disclosure.docx',
      });
      expect(withPath.deliveryGuide).toContain('E:\\tmpl\\my-disclosure.docx');
      expect(withPath.deliveryGuide).toContain('cannot be located');

      const noPath = buildDisclosure({ delivery: 'user-docx' });
      expect(
        noPath.issues.some(
          (i) => i.code === 'DISCLOSURE_USER_TEMPLATE_MISSING',
        ),
      ).toBe(true);
      expect(noPath.deliveryGuide).toContain('未提供 userTemplatePath');
    });

    it('markdown 交付指引指示写文件并保留占位', () => {
      const result = buildDisclosure({ delivery: 'markdown' });
      expect(result.deliveryGuide).toContain('markdown file');
      expect(result.deliveryGuide).toContain('placeholders as-is');
    });
  });
});
