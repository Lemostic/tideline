# Excel 导入生成看板 — 设计文档

- 日期：2026-11-03
- 版本目标：V0.15.0
- 状态：已获用户批准（入口形态、模板字段、文件格式、导入范围四项决策均已确认）

## 1. 目标

用户手里有一份 Excel（或 CSV）任务清单，希望**先定义看板名称，再把表格内容读进潮线，一次生成一个完整看板**（看板列 + 任务），而不是逐条手工录入。

配套要求：应用必须提供**可下载的导入模板**，用户按模板填写，导入时字段自动对齐。

## 2. 范围

### 2.1 包含

- 侧边栏新增「导入看板」入口 → 路由 `/import`；工作台「新建看板」旁新增「导入 Excel」快捷按钮跳同一页。
- 三步向导：① 基本信息（看板名称/描述/主题色 + 下载模板）→ ② 选择文件（`.xlsx` / `.csv`，支持拖拽）→ ③ 解析预览 → ④ 生成看板。
- 模板 `.xlsx`：含「任务」工作表（表头 + 空行 + 优先级下拉）与「填写说明」工作表。
- 导入 `.xlsx` / `.csv`，自动识别表头别名、解析日期/工时/优先级/标签。
- 生成：原子创建看板 + 看板列，随后逐条创建任务；失败自动回滚删除看板。
- 单元测试覆盖全部解析规则。

### 2.2 不包含（YAGNI）

- 不支持 `.xls`（老二进制格式），提示用户另存为 `.xlsx`。
- 不做「列 → 字段」的可视化映射界面，改为表头别名自动匹配。
- 不支持导入到已有看板（只新建看板）。
- 不支持任务父子层级（父任务列）、自定义字段、任务依赖、负责人。
- 不做导入历史记录与撤销。

## 3. 关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| Excel 读写位置 | 前端 TS 单库 `exceljs`（动态 `import()` 按需加载） | 浏览器模式与 Tauri 桌面端共用一套代码；模板可做样式与下拉；可单测。Rust `calamine` 方案会让浏览器模式缺能力 |
| 看板列创建 | 新增原子命令 `create_board_with_lists` | 避免「先建默认三列再删除」的脏中间态；单事务保证一致性 |
| 模板落盘 | Tauri 走新增 `save_binary_file` 命令（rfd 原生保存框），浏览器走 Blob 下载 | Tauri webview 拦截普通 Blob 下载 |
| 导入范围 | 仅新建看板 | 需求明确，避免范围膨胀 |
| 模板字段 | 标准 8 项 | 覆盖排期主干，够用且易填 |

### 降级预案

若 `exceljs` 在 Vite 浏览器端打包失败（实测已通过：8 modules，939.86 kB / gzip 271 kB），改为 `read-excel-file` + `write-excel-file` 双库，接口不变。

## 4. 界面流程

```
导入看板 (/import)
 ├─ 步骤 1 基本信息
 │    · 看板名称（必填，≤60 字）
 │    · 看板描述（选填）
 │    · 主题色（8 色，与新建看板一致）
 │    · 「下载 Excel 模板」按钮（右侧）
 ├─ 步骤 2 选择文件
 │    · 点击选择或拖拽 .xlsx / .csv
 │    · 解析中 spinner
 ├─ 步骤 3 预览
 │    · 统计条：X 列 · Y 任务 · Z 行有问题
 │    · 看板列清单（去重后按首次出现排序）
 │    · 预览表格（前 50 行）
 │    · 错误行明细（行号 + 原因）
 ├─ 步骤 4 生成
 │    · 进度：正在创建 60/128
 │    · 成功 → 顶部提示条 + 页面内成功面板（「去看板」/「再导入一个」），由用户决定何时跳转
    · 失败 → 自动删除半成品看板 + 明确原因
```

## 5. 模板结构

### 5.1 「任务」工作表

| 列 | 必填 | 说明 | 示例 |
|---|---|---|---|
| 任务标题 | 是 | 任务名，空则该行报错跳过 | 登录页联调 |
| 所属列 | 否 | 看板列名；空 → 「待办」；同名合并 | 进行中 |
| 描述 | 否 | 任务详情，支持多行 | 与后端对齐接口字段 |
| 开始日期 | 否 | 甘特起始 | 2026-11-03 |
| 截止日期 | 否 | 截止 | 2026-11-08 |
| 优先级 | 否 | 高/中/低 | 高 |
| 标签 | 否 | 多标签用逗号分隔 | 前端,联调 |
| 预估工时(分钟) | 否 | 数字或 1.5h / 2小时 / 1天 | 90 |

样式：表头加粗 + 深色底 + 白字、冻结首行、列宽预设、优先级列下拉（高/中/低）、第 2 行预留带格式的空行。

### 5.2 「填写说明」工作表

字段表（列名 / 是否必填 / 说明 / 示例）+ 日期格式说明 + 优先级取值 + 工时写法 + 标签分隔符 + 所属列规则。

## 6. 解析规则

### 6.1 表头别名

表头归一化：去空白、全角空格、`*`、`＊`、`：`,`:`、括号，仅保留中文/字母/数字。

| 字段 | 别名（归一化后） |
|---|---|
| 标题 | 任务标题、标题、任务名称、名称、任务、事项、需求 |
| 所属列 | 所属列、列、列表、所在列、看板列、分组、阶段、状态 |
| 描述 | 描述、详情、说明、备注、任务描述、内容 |
| 开始日期 | 开始日期、开始时间、起始日期、开始 |
| 截止日期 | 截止日期、结束日期、到期日、截止、结束、交付日期 |
| 优先级 | 优先级、优先度、紧急度 |
| 标签 | 标签、标签列表 |
| 预估工时 | 预估工时分钟、预估工时、工时、预估、预计工时 |

匹配规则：先精确匹配，再「表头以别名开头」匹配；同一字段以**最靠左的表头**为准；未匹配的表头忽略。

### 6.2 值解析

- **日期**：原生 `Date`（取本地年月日）、Excel 序列号（1..2958465）、`YYYY-MM-DD`、`YYYY/M/D`、`YYYY.M.D`、`YYYY年M月D日`、`M/D`（补当年）、ISO 时间戳取日期部分、`今天/明天/后天/昨天`。非法值 → 该字段留空并记警告。
- **优先级**：高/高优/紧急/high/p0/一级/1 → high；中/中优/普通/medium/p1/二级/2 → medium；低/低优/low/p2/三级/3 → low；其他 → 空。
- **工时**：纯数字按分钟；`1.5h`、`1.5小时`、`30m`、`30分钟`、`1天`/`1d`（=480 分钟）；非法 → 空 + 警告。
- **标签**：按 `,` `，` `、` `;` `；` `|` 切分，去空、去重。
- **描述**：单元格文本（多行保留）。

### 6.3 行处理

- 整行为空 → 静默跳过。
- 有内容但标题为空 → 记为错误行（行号 + 原因），跳过该行，不阻断整批。
- 其余列解析失败 → 警告，字段留空，任务照常导入。

### 6.4 列归并

`所属列` 去重后按**首次出现顺序**生成看板列；全空时生成单列「待办」。

## 7. 写入路径

```
ImportPage
  → api.createBoardWithLists({ title, description, color, listTitles })   // 原子，返回 { board, lists }
  → for each parsed card: store.createCard({ boardId, listId, ... })        // 复用既有增量快照更新
  → 任一步失败：api.deleteBoard({ id })  // 回滚，不留半成品
```

- 进度回调驱动 UI。
- 复用 `createCard` 的增量更新语义（与「需求拆解」页一致），避免整表重载。

## 8. 数据契约

```ts
// types.ts
export interface NewBoardWithListsInput {
  title: string;
  description?: string;
  color?: BoardColor;
  /** 看板列标题，按顺序创建 */
  listTitles: string[];
}

export interface CreatedBoardWithLists {
  board: Board;
  lists: List[];
}

export interface SavedBinaryFile {
  /** 桌面端为绝对路径，浏览器端为文件名 */
  path: string;
}
```

`TidelineApi` 新增：

```ts
createBoardWithLists(input: NewBoardWithListsInput): Promise<CreatedBoardWithLists>;
saveBinaryFile(input: { fileName: string; base64: string }): Promise<SavedBinaryFile>;
```

Rust 命令：

- `create_board_with_lists(input) -> CreatedBoardWithLists`：单事务插入 board + lists（并调用 `ensure_builtin_saved_views`）。
- `save_binary_file(input) -> SavedBinaryFile`：`rfd` 保存对话框 → 写文件；用户取消返回空路径。

## 9. 新增 / 修改文件

**新增**

- `src/lib/excelImport.ts` — 纯函数：表头映射、字段值解析、行映射、CSV 文本解析
- `src/lib/excelImport.test.ts` — vitest 单测
- `src/lib/excelFile.ts` — IO：`.xlsx`（动态 import exceljs）/ `.csv` → 行数组
- `src/lib/excelTemplate.ts` — 生成模板 workbook 字节
- `src/pages/ImportPage.tsx`、`src/pages/import.css`

**修改**

- `src/lib/types.ts`、`src/lib/api.ts`（双端实现）、`src/store/appStore.ts`
- `src/App.tsx`（路由）、`src/components/Sidebar.tsx`（入口）、`src/pages/WorkbenchPage.tsx`（快捷按钮）
- `src-tauri/src/models.rs`、`repo.rs`、`commands.rs`、`lib.rs`、`Cargo.toml`（base64）
- `package.json`、`pnpm-lock.yaml`（exceljs）

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 不支持的格式（`.xls` 等） | 提示「请另存为 .xlsx 或 .csv」，不进入解析 |
| 找不到标题列 | 提示「未找到任务标题列，请使用模板」并阻断 |
| 没有有效任务 | 提示「没有可导入的任务」并阻断 |
| 单行标题为空 | 跳过 + 预览标红计数 |
| 单字段格式错误 | 警告 + 留空 |
| 生成中途失败 | 删除已建看板 + 提示原因 |
| 超过 5000 行 | 提示上限并阻断 |

## 11. 测试

- `excelImport.test.ts`：日期（8 种格式 + 非法）、工时（5 种写法）、优先级（全部别名）、标签分隔符、表头别名映射与冲突、空行/错误行、列归并顺序、CSV 引号与分隔符嗅探。
- 手工验证：生成模板 → 填数据 → 导入 → 看板列与任务字段正确。
- `pnpm typecheck` + `pnpm test` + `pnpm build` 全绿。

## 12. 文档

- `docs/更新记录.md` 增补 V0.15.0 条目
- `README.md` 功能清单补充
