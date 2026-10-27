import { describe, expect, it } from 'vitest';

import { buildDisclosure } from './disclosure.ts';
import { checkDisclosure, countEffectiveChars } from './disclosure-check.ts';

/** 完整样例：七部分齐全、无占位。 */
const FULL_DOC = buildDisclosure({
  header: {
    caseName: '车载充电桩在线升级方法',
    applicationType: '发明',
    applicant: '某某科技有限公司',
    inventors: '张三',
    contactName: '张三',
    contactPhone: '13800000000',
    contactEmail: 'z@example.com',
    internalNo: 'N-001',
    published: '否',
  },
  sections: {
    background: [
      '现有充电桩固件升级需要停机现场操作，依赖人工连接调试口，升级流程繁琐且风险高。',
    ],
    problems: { main: '升级效率低、需要停机', minor: ['现场人力成本高'] },
    solution: [
      '本方案在充电桩主控中引入双分区固件布局，运行区与升级区独立存放。',
      '升级时通过蓝牙通道下发差分升级包到升级区，校验签名通过后原子切换分区指针，失败自动回滚。',
      '差分包生成采用 BSDiff 算法，服务端按硬件版本维护差分基线，典型包体积缩减到全量的十分之一以下。',
    ],
    effects: [
      '无需停机现场升级，升级时间从 2 小时缩短到 10 分钟，人力成本显著降低。',
    ],
    protectionPoints: ['双分区原子切换机制', '基于硬件版本的差分基线管理'],
    figureNotes: ['图1：系统整体框图'],
  },
}).markdown;

describe('dsh-patent', () => {
  describe('countEffectiveChars', () => {
    it('剔除占位、标记与空白', () => {
      expect(countEffectiveChars('〔待填写：提示〕正文内容')).toBe(4);
      expect(countEffectiveChars('〔待填写〕')).toBe(0);
    });
  });

  describe('checkDisclosure', () => {
    it('完整交底书：无 error、统计正确', () => {
      const report = checkDisclosure(FULL_DOC);
      expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.stats.sectionCount).toBe(7);
      expect(report.stats.solutionChars).toBeGreaterThan(100);
    });

    it('缺部分报 SECTION_MISSING', () => {
      const report = checkDisclosure(
        FULL_DOC.replace('## 六、本案需要保护的要点', '## 六、保护要点'),
      );
      expect(report.issues.some((i) => i.code === 'SECTION_MISSING')).toBe(
        true,
      );
      expect(report.ok).toBe(false);
    });

    it('头部占位逐字段报 HEADER_PLACEHOLDER（warning）', () => {
      const doc = buildDisclosure({
        header: { caseName: '测试方法' },
        sections: { solution: ['方案'.repeat(120)] },
      }).markdown;
      const report = checkDisclosure(doc);
      const placeholders = report.issues.filter(
        (i) => i.code === 'HEADER_PLACEHOLDER',
      );
      expect(placeholders.length).toBeGreaterThanOrEqual(6);
      expect(placeholders.every((i) => i.severity === 'warning')).toBe(true);
      expect(report.ok).toBe(true);
    });

    it('第三部分过短报 SOLUTION_SHALLOW（warning）', () => {
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: { solution: ['方案太简单。'] },
      }).markdown;
      const report = checkDisclosure(doc);
      expect(report.issues.some((i) => i.code === 'SOLUTION_SHALLOW')).toBe(
        true,
      );
    });

    it('第二部分未分主次报 PROBLEM_NO_PRIORITY（warning）', () => {
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: {
          solution: ['方案'.repeat(150)],
          problems: { main: '效率低' },
        },
      }).markdown;
      // buildDisclosure 对 main 有值时输出「最主要」结构——手工破坏它
      const broken = doc.replace(
        '**1.最主要、最关键的技术问题：** 效率低',
        '效率低',
      );
      const report = checkDisclosure(broken);
      expect(report.issues.some((i) => i.code === 'PROBLEM_NO_PRIORITY')).toBe(
        true,
      );
    });

    it('第三部分带 ### 子标题时字数统计不被截断', () => {
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: {},
      }).markdown;
      const withSub = doc.replace(
        '〔待填写：重点：完整公开技术手段与方法',
        '### 3.1 分区设计\n\n运行区与升级区独立存放，指针页双副本互为备份，boot_count 阈值触发回滚，失败自动回滚到运行区镜像。\n\n〔待填写：重点：完整公开技术手段与方法',
      );
      const report = checkDisclosure(withSub);
      expect(report.stats.solutionChars).toBeGreaterThan(30);
    });

    it('正文残留占位报 PLACEHOLDER_LEFT（warning）', () => {
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: { solution: ['方案'.repeat(150)] },
      }).markdown;
      const report = checkDisclosure(doc);
      expect(report.issues.some((i) => i.code === 'PLACEHOLDER_LEFT')).toBe(
        true,
      );
    });
  });
});
