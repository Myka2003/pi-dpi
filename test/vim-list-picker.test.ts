import { describe, expect, it } from "vitest";
import { VimListPicker, VimListState, type VimListItem } from "../src/vim-list-picker.ts";

const items = Array.from({ length: 55 }, (_, i) => ({
  id: `i${i}`,
  label: `item-${i}`,
  data: i,
}));

describe("VimListState 分页/跳转", () => {
  it("moveDown 到页尾自动翻页，moveUp 到页首翻上一页末项", () => {
    const s = new VimListState(items, 20);
    for (let i = 0; i < 20; i++) s.moveDown(); // 0..19 → 翻到第 2 页第 0 项
    expect(s.pageOffset).toBe(20);
    expect(s.sel).toBe(0);
    s.moveUp();
    expect(s.pageOffset).toBe(0);
    expect(s.sel).toBe(19);
  });

  it("jump(false) 到最后一页最后一项", () => {
    const s = new VimListState(items, 20);
    s.jump(false);
    expect(s.pageOffset).toBe(40);
    expect(s.sel).toBe(14); // 55 项：40..54，末项页内 14
  });

  it("jump(true) 回第一页第一项", () => {
    const s = new VimListState(items, 20);
    s.jump(false);
    s.jump(true);
    expect(s.pageOffset).toBe(0);
    expect(s.sel).toBe(0);
  });

  it("moveHalf 半页移动（^D/^U）", () => {
    const s = new VimListState(items, 20);
    s.moveHalf(true); // 下移 10
    expect(s.sel).toBe(10);
    s.moveHalf(false); // 回 0
    expect(s.sel).toBe(0);
  });

  it("movePage 整页移动（^F/^B），末页不越界", () => {
    const s = new VimListState(items, 20);
    s.movePage(true);
    expect(s.pageOffset).toBe(20);
    s.movePage(true);
    s.movePage(true);
    expect(s.pageOffset).toBe(40); // 55 项只有 3 页，停在 40
    s.movePage(false);
    expect(s.pageOffset).toBe(20);
  });

  it("initialId 初始定位到指定项", () => {
    const s = new VimListState(items, 20, "i25");
    expect(s.pageOffset).toBe(20);
    expect(s.sel).toBe(5);
  });
});

describe("VimListState 过滤", () => {
  it("setFilter 过滤后总数变化且游标重置", () => {
    const s = new VimListState(items, 20);
    s.setFilter("item-5");
    expect(s.visible().length).toBe(6); // item-5, item-50..54
    expect(s.pageOffset).toBe(0);
    expect(s.sel).toBe(0);
  });

  it("setFilter 空串清除过滤", () => {
    const s = new VimListState(items, 20);
    s.setFilter("item-5");
    s.setFilter("");
    expect(s.visible().length).toBe(55);
  });
});

describe("VimListState toggle 勾选", () => {
  it("toggleCurrent 切换当前项，checkedIds 返回最终集", () => {
    const s = new VimListState(items, 20);
    s.toggleCurrent(); // item-0
    s.moveDown();
    s.toggleCurrent(); // item-1
    s.moveDown();
    s.toggleCurrent(); // item-2
    s.moveUp();
    s.toggleCurrent(); // item-1 取消
    expect(s.checkedIds()).toEqual(["i0", "i2"]);
  });
});


function makePicker(items: VimListItem<string>[], onResult: (result: unknown) => void) {
  return new VimListPicker({
    title: "Sessions",
    items,
    mode: "select",
    theme: { fg: (_color: string, text: string) => text },
    onResult,
  });
}

describe("VimListPicker 搜索导航", () => {
  it("过滤时上下箭头移动当前选择项", () => {
    let result: unknown;
    const picker = makePicker(
      [
        { id: "a", label: "alpha", data: "alpha" },
        { id: "b", label: "beta", data: "beta" },
        { id: "c", label: "charlie", data: "charlie" },
      ],
      (value) => {
        result = value;
      },
    );

    picker.handleInput("/");
    picker.handleInput("a");
    picker.handleInput("down");
    picker.handleInput("down");
    picker.handleInput("enter");
    picker.handleInput("enter");

    expect(result).toMatchObject({ action: "pick", item: { id: "c" } });
  });
});
