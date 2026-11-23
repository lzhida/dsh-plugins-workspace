/**
 * 本地工具规格垫片：把 author-facing 参数规格编译成宿主 registry 认的
 * raw JSON-Schema 子集，并在 execute 前做同样的参数预校验。
 *
 * 为什么本包自带一份（而不是 import 上游）：机制真源是 vendored 垫片
 * plugins/dsh-taskboard/src/host/sdk.ts 的 defineTool，但 kanban-mode 与
 * dsh-taskboard 零跨包运行时 import（本卡硬约束），因此照该垫片**结构兼容
 * 重实现**同一机制——规格形状、编译结果、参数预校验与错误消息形状
 * （`Error: invalid arguments: …`）对齐；宿主 tools.register 拿到的
 * ToolDefinition 与上游 taskboard_* 工具完全同形。来源登记见
 * docs/upstream-alignment.md。
 *
 * 相对上游垫片的精简（本包参数面只用到这些节点）：标量 string/number/
 * integer/boolean、json（任意 JSON，注记-only）、array（标量/json 元素）；
 * 未实现嵌套 object 规格（上游 ObjectSpec），本包无嵌套对象参数。
 */

/** author-facing 标量规格。 */
export interface ToolScalarSpec {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly description?: string;
  readonly enum?: readonly string[];
}

/** author-facing json 规格（任意 JSON 值，编译为注记-only schema）。 */
export interface ToolJsonSpec {
  readonly type: 'json';
  readonly description?: string;
}

/** author-facing 数组规格。 */
export interface ToolArraySpec {
  readonly type: 'array';
  readonly items?: ToolValueSpec;
  readonly description?: string;
}

/** author-facing 值规格。 */
export type ToolValueSpec = ToolScalarSpec | ToolJsonSpec | ToolArraySpec;

/** author-facing 参数条目（值规格 + 顶层 required）。 */
export type ToolParameterSpec = ToolValueSpec & { readonly required?: boolean };

/** raw JSON-Schema 子集节点（宿主 registry 的入参 schema 形状）。 */
export type RawSchema = Record<string, unknown>;

/** 工具 render 的文本块（宿主 registry 包装进 result.content 喂给模型）。 */
export interface ToolTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** defineTool 的入参选项（照上游 DefineToolOptions 形状）。 */
export interface DefineToolOptions<A, V> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, ToolParameterSpec>>;
  readonly output: {
    readonly schema: { readonly type: 'json' };
    render(args: A, value: V): ToolTextBlock[];
  };
  execute(args: A, exec: unknown): Promise<V>;
}

/** registry-ready 工具定义（照上游 ToolDefinition 形状）。 */
export interface KanbanToolDefinition<A = unknown, V = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: RawSchema;
  readonly output: {
    readonly schema: RawSchema;
    render(args: A, value: V): ToolTextBlock[];
  };
  execute(args: A, exec: unknown): Promise<V>;
}

/** 编译一个值规格为 raw 子集节点（json → 注记-only）。 */
function compileValue(spec: ToolValueSpec): RawSchema {
  const node: RawSchema = {};
  if (spec.description !== undefined && spec.description.length > 0) {
    node.description = spec.description;
  }
  if (spec.type === 'json') return node;
  if (spec.type === 'array') {
    node.type = 'array';
    if (spec.items !== undefined) node.items = compileValue(spec.items);
    return node;
  }
  node.type = spec.type;
  if (spec.enum !== undefined) node.enum = [...spec.enum];
  return node;
}

/** 编译参数表：properties + 收集 required 列表。 */
function compilePropertyMap(
  spec: Readonly<Record<string, ToolParameterSpec>>,
): {
  properties: Record<string, RawSchema>;
  required?: string[];
} {
  const properties: Record<string, RawSchema> = {};
  const required: string[] = [];
  for (const [propName, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry;
    properties[propName] = compileValue(valueSpec);
    if (isRequired === true) required.push(propName);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/** 一个 JS 值是否匹配标量类型。 */
function matchesScalarType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

/** 对一个值做 raw 子集校验，返回带路径的违规清单。 */
function validateValue(
  schema: RawSchema,
  value: unknown,
  pathName: string,
): string[] {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return [];
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${pathName} must be an array`];
    const violations: string[] = [];
    const items = schema.items as RawSchema | undefined;
    if (items !== undefined) {
      value.forEach((item, index) => {
        violations.push(...validateValue(items, item, `${pathName}[${index}]`));
      });
    }
    return violations;
  }
  if (!matchesScalarType(value, schema.type)) {
    return [`${pathName} must be ${schema.type}`];
  }
  const enumValues = schema.enum as string[] | undefined;
  if (enumValues !== undefined && !enumValues.includes(value as string)) {
    return [`${pathName} must be one of ${enumValues.join(', ')}`];
  }
  return [];
}

/** 对整包参数做顶层校验（required + 类型 + enum）。 */
function validateArguments(parameters: RawSchema, args: unknown): string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return ['arguments must be an object'];
  }
  const present = args as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of (parameters.required as string[] | undefined) ?? []) {
    if (!(key in present) || present[key] === undefined) {
      violations.push(`arguments.${key} is required`);
    }
  }
  const properties = (parameters.properties as Record<string, RawSchema>) ?? {};
  for (const [key, child] of Object.entries(properties)) {
    if (key in present && present[key] !== undefined) {
      violations.push(
        ...validateValue(child, present[key], `arguments.${key}`),
      );
    }
  }
  return violations;
}

/**
 * 定义一个看板模式工具：编译参数规格、预校验入参（消息格式与上游垫片
 * 一致），透传 render / execute。
 */
export function defineTool<A extends object, V>(
  options: DefineToolOptions<A, V>,
): KanbanToolDefinition<A, V> {
  const compiled = compilePropertyMap(options.parameters);
  const parameters: RawSchema = {
    type: 'object',
    properties: compiled.properties,
  };
  if (compiled.required !== undefined) parameters.required = compiled.required;
  const userExecute = options.execute;
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      // 与上游一致：json 输出节点编译为注记-only schema（空对象）。
      schema: {},
      render(args, value) {
        return options.output.render(args, value);
      },
    },
    async execute(args, exec) {
      const violations = validateArguments(parameters, args);
      if (violations.length > 0) {
        throw new Error(`Error: invalid arguments: ${violations.join('; ')}`);
      }
      return userExecute(args, exec);
    },
  };
}
