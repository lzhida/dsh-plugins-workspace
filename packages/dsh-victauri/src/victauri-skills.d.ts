/**
 * 手写最小模块声明：ctx.skills（宿主 dsh-base 顶层提供的 skill 注册表）。
 *
 * 运行时服务由宿主的 @deepseek-ai/dsh-skill（SkillRegistry）提供，本插件
 * 只向其注册内容，不自带服务实现。因不能新增依赖（pnpm-lock.yaml 受父卡
 * 约束保护），这里按 @deepseek-ai/dsh-skill 0.2.1-rc.2 的 SkillRegistration
 * 手写最小签名；将来若允许新增 devDependency，应删除本文件并直接引用真类型。
 *
 * 注意：dsh-skill 的 kebab-case 名校验（isSkillName）由服务端执行，本声明
 * 只约束到 string，skill 名的静态规范由 skill-content.test.ts 锁定。
 */
import '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly skills: {
      /**
       * 注册一条运行时 skill（与 @deepseek-ai/dsh-skill 的
       * SkillRegistration 最小对齐：name/description/content/source 必需，
       * invocation 可选，缺省即 model 与 user 双面可调用）。
       * 返回类型与 dsh-skill 0.2.1-rc.2 的 register 一致：注销 disposer。
       */
      register(skill: {
        readonly name: string;
        readonly description: string;
        readonly content: string;
        readonly source: string;
        readonly invocation?: {
          readonly modelInvocable: boolean;
          readonly userInvocable: boolean;
        };
      }): () => void;
    };
  }
}

export {};
