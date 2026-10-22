// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string) => ({ itemId, title }) as ReportCitation;
const csrc = cite("a", "证监会就程序化交易管理新规公开征求意见，明确高频交易报告要求");
const pbc = cite("b", "人民银行宣布下调存款准备金率 0.5 个百分点，释放长期资金约一万亿元");

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf("人民银行下调存款准备金率 0.5 个百分点，释放长期资金约一万亿元", [csrc, pbc], [csrc, pbc])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf("多家券商发布年度业绩，行业分化加剧", [csrc], [csrc, pbc]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [csrc], [pbc, csrc])?.itemId, "a");
});
