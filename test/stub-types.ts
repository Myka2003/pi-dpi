// 类型 stub：测试中只 import 被测模块（src/*、extensions/session-vcs），
// 它们对 pi 包的导入均为 type-only（编译期擦除）；此文件兜底任何意外的
// 运行时包导入，避免 vitest 解析真实 pi 包。
export default {};
