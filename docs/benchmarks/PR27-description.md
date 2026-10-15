# PR #27 描述草稿（禁止合并 / Draft，不自动合并）

> 本文件是 GitHub PR 描述的粘贴稿；CI 通过后仍保持 Draft，不执行合并。

## 状态

- CI：通过（typecheck / lint 0 errors / Vitest 563 passed + 6 skipped / build / audit 0 / E2E 23 passed + 2 skipped；2026-10-15 本机复核三项关键测试 17 passed）。
- 100k JSON / ZIP 恢复及回滚：通过。
- V1/V2 → V3 数据库升级：通过。
- 143 次完整性检查：全部为 0。
- 性能：单条编辑、启动、导入、排序明显提升；100k JSON 导出中位数改善；仅 `readSnapshot` 单读微基准未达“无退化”字面要求（混合 +11.1%，独立 +2.7%）。

## 本次专项复查结论（2026-10-15，仅性能验收）

- 对已有 Chromium 原始样本的事后统计复核（同一版本/Chromium/机器/数据集；混合 n=5，独立 3 profile×7，原生 21 对）；未改生产读取路径，未在 Windows 重跑 100k Chromium。
- 混合 100k：1,589.3 [1,441.5–1,808.3] → 1,765.9 [1,596.7–2,468.5]；独立：1,583.5 [1,448.7–1,724.9] → 1,626.7 [1,381.6–2,483.1]；After 分 profile 中位数 1,626.7 / 1,739.5 / 1,478.5，其中一个快于全部 Before；Mann-Whitney 均不显著（p≈0.14 / 0.48）。
- Dexie 单 readonly 事务开销不能解释变慢（旧 3 事务 vs 新 1 事务；原生仅快 2.5% 已放弃）；受控全表读取反而改善 6.5%（1,707.3→1,597.1）；18k 单读改善 7.5%，指向大对象图 GC/堆与混合负载顺序方差。
- 系统级读取成本下降：启动 2→1 次、编辑 1→0 次；100k 启动省约 4.7 s、编辑 API 省约 1.5 s、导入省约 20 s，远大于单次百毫秒波动。
- 无简单可靠优化可做且不做：不移除一致性事务、不减字段、不加分页/缓存；原生方案已拒绝。
- V1 自由文本备注跨设备不可恢复仍是已知限制，未解决，转后续版本化备份合同任务。

## 合并建议

**NO（窄阻塞）**：仅单读微基准未满足字面“无退化”；完整性/备份/升级通过。建议将验收放宽为“系统级工作流总耗时 + 完整性计数”，或做 n≥30 预注册等效性验证；不要为该微基准增加架构复杂度。保持草稿，不自动合并。

原始数据：`docs/benchmarks/large-ledger/{before,after,read-before,read-after,read-native,backup,migration,index,phase-a}.json`；分析见 `docs/benchmarks/large-ledger-optimization-report.md` 2026-10-15 节；校验见 `docs/benchmarks/large-ledger/validation.json`。
