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

    it('第三部分全占位骨架（0 字）也报 SOLUTION_SHALLOW 并写明骨架形态', () => {
      // 修复前 0 字不报（solutionChars > 0 条件漏掉骨架形态）
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: {},
      }).markdown;
      const report = checkDisclosure(doc);
      const shallow = report.issues.find((i) => i.code === 'SOLUTION_SHALLOW');
      expect(shallow).toBeDefined();
      expect(shallow?.message).toContain('没有有效正文');
    });

    it('全文任意两段公共后缀 ≥100 字报 DUPLICATE_TEXT（正例）', () => {
      // 初稿真实形态：同一段 170 字文本在摘要/说明书多处逐字复制
      const shared =
        '升级完成后系统自动校验分区一致性并写入版本号，随后重启主控进入运行区执行新固件，整个流程无需人工到场确认。'.repeat(
          2,
        );
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: {
          background: [`现场升级的历史流程描述。${shared}`],
          solution: [`本方案改为远程静默升级。${shared}`],
        },
      }).markdown;
      const report = checkDisclosure(doc);
      const dup = report.issues.filter((i) => i.code === 'DUPLICATE_TEXT');
      expect(dup.length).toBeGreaterThanOrEqual(1);
      expect(dup[0]?.message).toMatch(/逐字相同的公共后缀/);
    });

    it('无大段复用的正常文档不报 DUPLICATE_TEXT（反例）', () => {
      const report = checkDisclosure(FULL_DOC);
      expect(report.issues.some((i) => i.code === 'DUPLICATE_TEXT')).toBe(
        false,
      );
    });

    it('第三与第五部分成对复用段落报 SECTION_DUPLICATE（正例）', () => {
      // 初稿真实形态：发明内容「本方案…」与实施方式「在本实施例中…」
      // 开头不同、后半段逐字相同（公共后缀 ≥40 但 <100，只触发部分间检测）
      const shared =
        '校验签名通过后原子切换分区指针，失败自动回滚到运行区镜像并记录升级日志，保证升级过程断电安全可靠，不丢失历史配置。';
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: {
          solution: [`本方案在升级区完成差分包校验。${shared}`],
          effects: [`在本实施例中，升级区完成差分包校验的流程如下。${shared}`],
        },
      }).markdown;
      const report = checkDisclosure(doc);
      const pair = report.issues.filter((i) => i.code === 'SECTION_DUPLICATE');
      expect(pair.length).toBeGreaterThanOrEqual(1);
      expect(pair[0]?.message).toContain('第三部分与第五部分');
      // 后缀 60 字 < 100：全文级检测不应重复报
      expect(report.issues.some((i) => i.code === 'DUPLICATE_TEXT')).toBe(
        false,
      );
    });

    it('第三与第五部分无对应复用不报 SECTION_DUPLICATE（反例）', () => {
      const report = checkDisclosure(FULL_DOC);
      expect(report.issues.some((i) => i.code === 'SECTION_DUPLICATE')).toBe(
        false,
      );
    });

    it('「所述X」术语互为包含报 TERM_VARIANT_PAIR（正例）', () => {
      // 初稿真实形态：互逆转义表/转义表三名称并存、协议描述文件/描述文件
      // 多种指称——交底阶段应统一术语
      const doc = buildDisclosure({
        header: { applicant: '某公司', inventors: '李四' },
        sections: {
          solution: [
            '本方案维护所述互逆转义表，升级时加载所述转义表并比对所述协议描述文件与所述描述文件的版本号，加载所述读存转义表前需校验所述读存表与所述参数树一致后再切换分区，所述互逆映射表仅在初始化阶段构建。'.repeat(
              6,
            ),
          ],
        },
      }).markdown;
      const report = checkDisclosure(doc);
      const variants = report.issues.filter(
        (i) => i.code === 'TERM_VARIANT_PAIR',
      );
      // 初稿真实样例入库：互逆转义表/转义表/互逆映射表三名称并存、读存
      // 转义表/读存表（前缀变体）、协议描述文件/描述文件多种指称（读存表
      // 与互逆映射表属前缀变体，不在「互为包含」可检范围；入库为回归样例）
      expect(variants.length).toBeGreaterThanOrEqual(2);
      expect(
        variants.some(
          (i) =>
            i.message.includes('转义表') && i.message.includes('互逆转义表'),
        ),
      ).toBe(true);
      expect(
        variants.some(
          (i) =>
            i.message.includes('描述文件') &&
            i.message.includes('协议描述文件'),
        ),
      ).toBe(true);
    });

    it('术语规范统一的文档不报 TERM_VARIANT_PAIR（反例）', () => {
      const report = checkDisclosure(FULL_DOC);
      expect(report.issues.some((i) => i.code === 'TERM_VARIANT_PAIR')).toBe(
        false,
      );
    });
  });
});
