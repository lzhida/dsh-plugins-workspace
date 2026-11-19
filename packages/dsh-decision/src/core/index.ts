/**
 * dsh-decision 核心层：配置面与宿主类型面。
 *
 * 核心层只放「与具体决策点无关」的共用件：
 * - `config.ts`：配置 schema（volatile 字段 + 中英描述），1/4 只落总开关与
 *   决策模型定位两个基础字段；
 * - `user-questions.ts`：宿主 `ctx.userQuestions` 的本地最小类型面。
 */

export {
  Config,
  desc,
  isVolatileLike,
  resolveConfig,
  setDescription,
  unwrapVolatile,
  volatileField,
} from './config.ts';
export type { ResolvedConfig, SchemaDescription } from './config.ts';

export type {
  UserQuestionAnswer,
  UserQuestionAnswerItem,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionRequestItem,
  UserQuestionsLike,
} from './user-questions.ts';
