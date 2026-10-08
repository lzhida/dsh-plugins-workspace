// @lzhida/dsh-nushell 组合包:纯接线包,无运行时逻辑。
// 本包自身不作为插件条目加载(cordis.patch.yml 只 insert 两个实现件);
// main 仅满足打包元数据约定。装载日志由被插入的实现件输出
// ([dsh-tool-nushell] / [dsh-nushell-sandbox],见 e2e 契约)。
export {};
