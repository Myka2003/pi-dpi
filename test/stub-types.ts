// 类型 stub：测试中只 import 被测模块（src/*、extensions/session-vcs），
// 它们通常只导入 pi 类型；这里也提供选择器运行时所需的最小 Key/matchesKey，
// 避免 vitest 解析真实 pi 包。
export const Key = {
  escape: "escape",
  enter: "enter",
  backspace: "backspace",
  pageUp: "pageUp",
  pageDown: "pageDown",
  up: "up",
  down: "down",
  ctrl: (key: string) => `ctrl+${key}`,
};

export function matchesKey(data: string, key: string): boolean {
  return data === key;
}

export default {};
