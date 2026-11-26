# Zoned Slice Lab · 带时区日期条件的按天分区裁剪实验台

一块本地查询实验台：数据按 **UTC 日**物理分区，查询条件却写成**带时区的本地日期**。
它演示并验证一件事——把 `local_date(ts) = DATE '2026-03-08'` 这样的谓词**精确**地
翻译成 UTC 区间集合，只打开真正可能命中的分区；并且把"到底扫了哪些分区、聚合是否与
逐行计算一致"完整摊开给人看。

没有依赖：Node 内置 `node:sqlite`、`node:http`，时区数据来自同一份 ICU/tzdata。
界面是零框架的原生 ES 模块 + CSS。

```
npm run seed   # 生成 .data/lab.sqlite（365 个分区 / 263,927 行，约 5s）
npm start      # http://localhost:5180
npm test       # 66 个测试（无浏览器时用内置的最小 DOM 跑端到端）
```

## 核心模型

**查询时区不是存储时区。** 分区键是 UTC 日；本地日是另一层语义：

| 情形 | 例子 | 本地日长 | 影响 |
|---|---|---|---|
| 春季跳变 | `America/New_York` 2026-03-08 | 23h | 本地日跨两个 UTC 分区 |
| 秋季回拨 | `America/New_York` 2026-11-01 | 25h | 同一本地小时出现两次 |
| 午夜被跳过 | `America/Havana` 2026-03-08 | 23h | 本地日从 01:00 开始 |
| 午夜重复 | `America/Havana` 2026-11-01 | 25h | 午夜这一时刻出现两次 |
| 半小时夏令时 | `Australia/Lord_Howe` 2026-10-04 | 23.5h | 偏移以 30 分钟跳变 |
| 非整点偏移 | `Pacific/Chatham` | 24h | +12:45 / +13:45 |

因此**不能**把"本地日期"当成"UTC 日期"来裁剪。界面里的"按 UTC 直读"模式就是那个
错误实现：它会在哈瓦那 2026-03-08 少开一个分区、漏掉约 59 行——诊断面板会直接指出来。

## 表达式如何变成分区集合

```
local_date(ts) >= DATE '2026-03-01'
  AND local_ts(ts) < WALL '2026-03-15 02:00:00'
```

1. **分段。** 时间线上相邻两次 UTC 偏移跳变之间，本地日期与本地墙钟都是 UTC 的仿射
   函数，于是每个比较在每段里都有闭式边界（`compiler.mjs: eachSegment`）。
2. **区间集合。** 每个比较产出精确的 `[loUs, hiUs)` 半开区间集合；`AND/OR/NOT/
   BETWEEN/IN` 分别对应交、并、补（补集在数据集范围内取），所以否定与析取同样精确。
3. **裁剪。** 把区间集按 UTC 日切分，只保留有正重叠的日子，并记录每日覆盖比例
   （`selectPartitions`）。
4. **语义不靠裁剪。** 执行时逐行**重新求值**谓词；裁剪只是物理优化。所以"裁剪结果"
   与"全表扫描"可以互相校验，而不是自证。

时间线（`ZoneTimeline`）用 `Intl` 以 6 小时步长采样、再二分到秒级，精确找出 2026 年
所有跳变；之后每行的本地时间换算都是整数运算（无需逐行调用 `Intl`）。

## 三条独立答案路径

| 路径 | 读什么 | 何时精确 |
|---|---|---|
| 裁剪扫描 | 只打开选中分区，逐行求值 | 始终 |
| 全表扫描 | 打开全部 365 个分区，同一谓词逐行求值 | 始终（作为对照） |
| 预聚合 | 分钟桶 / 分区清单 | 区间边界对齐到分钟 / 选中整日时 |

三者互不依赖。一致性核对页（`verifyQuery`）做四件事：

- **区间语义**：在分区边界、每次偏移跳变点 ±1µs、每个区间端点抽样，逐点比较"逐行
  谓词真值"与"区间集成员关系"；
- **分区选择**：逐行暴力扫描，任何命中行必须落在已选分区内（soundness），每个被选
  分区必须真的含有一个满足谓词的时刻（necessity）；
- **聚合一致**：分钟桶 / 分区清单的 count、字节、延迟、错误数逐项对逐行真值；
- **裁剪 = 全表**：同一谓词下两种扫描命中数必须相等。

## 下钻页

`/drill.html?day=2026-03-09&zone=America/Havana&expr=…` 展示：

- 物理分区事实（表名、UTC 起止、行数、min/max ts）；
- 本查询在该分区的覆盖（整日 / 部分、重叠时长、每段 UTC 与本地范围）；
- 相邻三个本地日的解剖：日长、日首日尾、午夜是否存在 / 出现几次、跳变点；
- UTC 24 桶 与 **本地小时**（跳变日不是 24 桶，重复小时标橙、缺失小时留空）；
- **三方对账**：manifest 聚合、分钟桶聚合、逐行扫描逐项比对（全部来自不同存储路径）；
- 分区首/末三行，带本地时间与偏移。

## 语言

```
字段   ts               UTC 瞬时
       local_date(ts)    查询时区下的本地日历日
       local_ts(ts)      查询时区下的本地墙钟（秒级）
字面量 DATE 'YYYY-MM-DD'
       WALL 'YYYY-MM-DD HH:MM:SS'
       TS   'YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH:MM)'
       AT   'YYYY-MM-DD HH:MM:SS'   墙钟→瞬时，按重复策略解析
策略   earlier / later / both      重复小时或重复午夜时取哪一次
```

## HTTP 接口

| 端点 | 说明 |
|---|---|
| `GET /api/meta` | 运行环境、数据集范围、时区及其注意事项、预设查询 |
| `POST /api/query` | `{expression, zone, policy, mode, verify, withFullScan, limit}` |
| `GET /api/day?day=&zone=&policy=&mode=&expression=` | 分区下钻数据 |
| `GET /api/zone?zone=` | 全年本地日长异常与偏移跳变（供热力图标注） |

## 代码结构

```
server/tz.mjs        本地日解剖、跳变发现、日首二分、整数换算
server/intervals.mjs 半开区间集合代数
server/expr.mjs      词法 / 语法 / 类型校验
server/compiler.mjs  谓词 → 精确 UTC 区间集 → 分区选择
server/db.mjs        SQLite 打开与分区清单
server/seed.mjs      365 个日分区的数据播种（含边界时刻与分钟桶）
server/query.mjs     三条执行路径 + 一致性核对
server/index.mjs     HTTP 服务与页面路由
public/              实验台（index/main）与下钻页（drill）
test/                单元、差分、端到端（含最小 DOM）
```

`npm test` 在没有播种数据的机器上会自动跳过依赖数据库的用例。
