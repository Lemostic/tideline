# Excel 导入生成看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在潮线里先定义看板名称，再导入 `.xlsx` / `.csv` 任务表，一次生成含看板列与任务的完整看板，并提供可下载的 Excel 导入模板。

**Architecture:** 前端三层——`excelImport.ts` 纯函数解析层（可单测，不依赖 exceljs）、`excelFile.ts` / `excelTemplate.ts` IO 层（动态 `import('exceljs')` 按需加载）、`ImportPage.tsx` 三步向导 UI。写入路径复用既有 `createCard` 增量快照语义，新增原子命令 `create_board_with_lists` 建看板 + 列，失败回滚删看板。

**Tech Stack:** React 18 + TypeScript + Vite 6 + Zustand；Tauri 2 + Rust（rusqlite / rfd）；vitest；exceljs 4.4.0（动态导入）。

## Global Constraints

- 依赖只新增 `exceljs`，通过 `pnpm add exceljs` 安装并提交 `pnpm-lock.yaml`。
- exceljs 必须用**动态 `import()`** 加载，不得进入主包静态依赖图。
- 所有新增前端逻辑必须同时支持 Tauri 桌面端与浏览器开发模式（`api.ts` 的 `tauriApi` / `localApi` 双实现）。
- 日期一律存 `YYYY-MM-DD` 字符串；原生 `Date` 单元格必须按**本地时区**取年月日（禁止 `toISOString()`）。
- 新增文案与注释用简体中文；注释风格对齐现有 `src/lib/*.ts`（文件头块注释 + 关键函数注释）。
- 命令行使用 PowerShell 语法；单引号字面量；不修改与本功能无关的文件。
- 提交信息遵循仓库惯例：`feat(v0.15.0): 中文描述`。

---

### Task 1: 纯函数解析层 `excelImport.ts` + 单测

**Files:**
- Create: `src/lib/excelImport.ts`
- Test: `src/lib/excelImport.test.ts`

**Interfaces:**
- Consumes: `Priority` from `@/lib/types`
- Produces:
  ```ts
  export type ImportCell = string | number | boolean | Date | null | undefined;
  export type ImportField = 'title' | 'list' | 'description' | 'startDate' | 'dueDate' | 'priority' | 'labels' | 'estimatedMinutes';
  export interface ImportColumnMap { [K in ImportField]: number }   // -1 表示缺失
  export interface ParsedImportCard {
    title: string; listTitle: string; description: string;
    startDate: string | null; dueDate: string | null;
    priority: Priority | null; labels: string[]; estimatedMinutes: number | null;
    rowNumber: number; warnings: string[];
  }
  export interface ImportRowError { rowNumber: number; reason: string }
  export interface ImportParseResult {
    columns: ImportColumnMap; listTitles: string[]; cards: ParsedImportCard[];
    errors: ImportRowError[]; warnings: string[]; totalRows: number;
  }
  export function normalizeHeader(text: string): string
  export function mapHeaders(headerRow: ImportCell[]): ImportColumnMap
  export function parseDateValue(value: ImportCell): { date: string | null; invalid: boolean }
  export function parseMinutesValue(value: ImportCell): { minutes: number | null; invalid: boolean }
  export function parsePriorityValue(value: ImportCell): Priority | null
  export function parseLabelsValue(value: ImportCell): string[]
  export function cellText(value: unknown): string
  export function parseImportRows(rows: ImportCell[][]): ImportParseResult
  export function parseCsvText(text: string): ImportCell[][]
  export function summarizeImport(result: ImportParseResult): string
  ```

- [ ] **Step 1: 写失败测试** `src/lib/excelImport.test.ts`，覆盖：
  - `normalizeHeader('预估工时(分钟)')` → `'预估工时分钟'`；`normalizeHeader(' 任务标题 ')` → `'任务标题'`
  - `mapHeaders([['任务标题','所属列','截止日期']])` → `{title:0,list:1,dueDate:2, ...其余 -1}`
  - `mapHeaders([['标题','任务名称']])` → title 取 0（最左）
  - `parseDateValue(new Date(2026,10,3))` → `'2026-11-03'`（本地时区）
  - `parseDateValue('2026/11/3')`、`'2026.11.3'`、`'2026年11月3日'`、`'11/3'`（补当年）、`'2026-11-03T10:00:00Z'` → `'2026-11-03'`
  - `parseDateValue('不是日期')` → `{date:null, invalid:true}`；`parseDateValue('')` → `{date:null, invalid:false}`
  - `parseMinutesValue('90')` → 90；`'1.5h'` → 90；`'2小时'` → 120；`'1天'` → 480；`'abc'` → invalid
  - `parsePriorityValue('P0')` → `'high'`；`'低'` → `'low'`；`'普通'` → `'medium'`；`'xyz'` → null
  - `parseLabelsValue('前端，联调; 后端')` → `['前端','联调','后端']`
  - `parseImportRows`：空行静默跳过；有内容无标题 → 进 errors；列归并顺序 = 首次出现顺序；空所属列 → `'待办'`
  - `parseCsvText('a,b\n"x,y",2')` → `[['a','b'],['x,y','2']]`；制表符分隔自动嗅探
- [ ] **Step 2: 运行测试确认失败**
  Run: `pnpm vitest run src/lib/excelImport.test.ts`
  Expected: FAIL — 模块不存在
- [ ] **Step 3: 实现 `src/lib/excelImport.ts`**
  - `normalizeHeader`：去空白/全角空格/`*`/`＊`/`(`/`) （）`/`:`/`：`/`，保留中文字母数字
  - `HEADER_ALIASES`：`Record<ImportField, string[]>`，顺序即匹配优先级（title → list → description → startDate → dueDate → priority → labels → estimatedMinutes）
  - `mapHeaders`：逐列找第一个未占用且匹配的字段；精确匹配优先于前缀匹配
  - `parseDateValue`：`Date` → 本地 `getFullYear/getMonth+1/getDate`；数字 → Excel 序列号（`< 100000`）或 `YYYYMMDD`（8 位）；字符串按设计文档 6.2 顺序匹配
  - `parseImportRows`：首行作表头；`cellText` 处理 ExcelJS 富文本/公式/超链接对象
  - `parseCsvText`：去 BOM → 嗅探分隔符（`,` `;` `\t`，取出现次数最多者）→ 支持引号转义
- [ ] **Step 4: 运行测试确认通过**
  Run: `pnpm vitest run src/lib/excelImport.test.ts`
  Expected: PASS
- [ ] **Step 5: 提交**
  ```bash
  git add src/lib/excelImport.ts src/lib/excelImport.test.ts
  git commit -m "feat(v0.15.0): 新增 Excel 导入解析层与单元测试"
  ```

---

### Task 2: 模板生成与文件读取（exceljs 动态加载）

**Files:**
- Create: `src/lib/excelTemplate.ts`
- Create: `src/lib/excelFile.ts`

**Interfaces:**
- Consumes: `parseImportRows` / `parseCsvText` / `cellText` from `@/lib/excelImport`
- Produces:
  ```ts
  // excelTemplate.ts
  export const TEMPLATE_FILE_NAME = '潮线看板导入模板.xlsx';
  export async function buildTemplateBytes(): Promise<Uint8Array>
  // excelFile.ts
  export interface ImportFileResult { fileName: string; rows: ImportCell[][]; sheetNames: string[] }
  export async function readImportFile(file: File): Promise<ImportFileResult>
  ```

- [ ] **Step 1: 实现 `src/lib/excelTemplate.ts`**
  - `const { default: ExcelJS } = await import('exceljs')`
  - 工作表「任务」：第 1 行表头（加粗、深色底、白字、冻结 `ySplit:1`）、8 列列宽、第 2 行留带格式空行、优先级列加 `dataValidation` 下拉（高/中/低）
  - 工作表「填写说明」：字段表 + 日期/优先级/工时/标签规则说明
  - `await wb.xlsx.writeBuffer()` → `new Uint8Array(buffer)`
- [ ] **Step 2: 实现 `src/lib/excelFile.ts`**
  - 按扩展名分流：`.csv` → `file.text()` → `parseCsvText`；`.xlsx` → `file.arrayBuffer()` → 动态 import exceljs → `workbook.xlsx.load()` → 取工作表（优先名为「任务」，否则第一个）→ `eachRow` 取 `row.values.slice(1)`
  - 单元格值经 `cellText` 归一（`Date` 原样保留）
  - 其他扩展名抛错，文案「请另存为 .xlsx 或 .csv 后再导入」
  - 行数上限 5000，超出抛错
- [ ] **Step 3: 手工验证模板可读**
  Run: `node .verify/xlsx-probe.cjs`（已在仓库内，验证 exceljs 读写往返）
  Expected: 打印 rows 与 date cell 类型
- [ ] **Step 4: 提交**
  ```bash
  git add src/lib/excelTemplate.ts src/lib/excelFile.ts
  git commit -m "feat(v0.15.0): 新增导入模板生成与文件读取"
  ```

---

### Task 3: 后端原子命令（Rust）

**Files:**
- Modify: `src-tauri/Cargo.toml`（新增 `base64 = "0.22"`）
- Modify: `src-tauri/src/models.rs`（`NewBoardWithListsInput` / `CreatedBoardWithLists` / `SaveBinaryFileInput` / `SavedBinaryFile`）
- Modify: `src-tauri/src/repo.rs`（`create_board_with_lists`）
- Modify: `src-tauri/src/commands.rs`（两个命令）
- Modify: `src-tauri/src/lib.rs`（注册命令）

**Interfaces:**
- Produces:
  ```rust
  // models.rs
  pub struct NewBoardWithListsInput { title, description: Option<String>, color: Option<BoardColor>, list_titles: Vec<String> }
  pub struct CreatedBoardWithLists { board: Board, lists: Vec<List> }
  pub struct SaveBinaryFileInput { file_name: String, base64: String }
  pub struct SavedBinaryFile { path: String }
  // repo.rs
  pub fn create_board_with_lists(conn: &mut Connection, input: NewBoardWithListsInput) -> DbResult<CreatedBoardWithLists>
  ```

- [ ] **Step 1: `repo.rs` 实现 `create_board_with_lists`**
  - 单事务：插入 board（复用 `create_board` 的字段默认值与 `ensure_builtin_saved_views`）→ 遍历 `list_titles` 插入 list（`position` 递增、`color` 取 `BoardColor::Slate`）→ commit
  - `list_titles` 为空时插入一条「待办」
- [ ] **Step 2: `commands.rs` 实现两个命令**
  - `create_board_with_lists(db, input) -> CmdResult<CreatedBoardWithLists>`
  - `save_binary_file(input) -> CmdResult<SavedBinaryFile>`：`rfd::FileDialog::new().set_file_name(&input.file_name).save_file()` → 取消返回 `path: ""`；否则 base64 解码写文件并返回绝对路径
- [ ] **Step 3: `lib.rs` 注册** `commands::create_board_with_lists`、`commands::save_binary_file`
- [ ] **Step 4: 编译校验**
  Run: `cargo check --manifest-path src-tauri/Cargo.toml`
  Expected: 编译通过
- [ ] **Step 5: 提交**
  ```bash
  git add src-tauri
  git commit -m "feat(v0.15.0): 新增建看板列与保存二进制文件命令"
  ```

---

### Task 4: 前端 API 与 Store 接入

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/appStore.ts`

**Interfaces:**
- Consumes: Rust 命令名 `create_board_with_lists` / `save_binary_file`
- Produces:
  ```ts
  // types.ts
  export interface NewBoardWithListsInput { title: string; description?: string; color?: BoardColor; listTitles: string[] }
  export interface CreatedBoardWithLists { board: Board; lists: List[] }
  export interface SavedBinaryFile { path: string }
  // api.ts
  createBoardWithLists(input: NewBoardWithListsInput): Promise<CreatedBoardWithLists>;
  saveBinaryFile(input: { fileName: string; base64: string }): Promise<SavedBinaryFile>;
  // appStore.ts
  createBoardWithLists(input: NewBoardWithListsInput): Promise<CreatedBoardWithLists | undefined>;
  ```

- [ ] **Step 1: `types.ts` 补类型**（放在 `NewBoardInput` 之后）
- [ ] **Step 2: `api.ts` 补接口与双端实现**
  - `tauriApi`：`invoke('create_board_with_lists', { input })`、`invoke('save_binary_file', { input })`
  - `localApi.createBoardWithLists`：写 localStorage —— 建 board + lists，返回 `{ board, lists }`
  - `localApi.saveBinaryFile`：`base64` → `Uint8Array` → Blob → `<a download>` 触发下载，返回 `{ path: fileName }`
- [ ] **Step 3: `appStore.ts` 补 action**
  - `createBoardWithLists`：调 api → `getSnapshot()` 全量刷新 → 写入 snapshot → 返回结果
- [ ] **Step 4: 类型校验**
  Run: `pnpm typecheck`
  Expected: 无错误
- [ ] **Step 5: 提交**
  ```bash
  git add src/lib/types.ts src/lib/api.ts src/store/appStore.ts
  git commit -m "feat(v0.15.0): 接入导入看板的 API 与状态层"
  ```

---

### Task 5: 导入向导页面

**Files:**
- Create: `src/pages/ImportPage.tsx`
- Create: `src/pages/import.css`

**Interfaces:**
- Consumes: `readImportFile` / `parseImportRows` / `summarizeImport` / `buildTemplateBytes` / store `createBoardWithLists` / `createCard` / api `deleteBoard` / `saveBinaryFile`
- Produces: 路由组件 `ImportPage`

- [ ] **Step 1: 实现页面骨架**
  - 步骤状态 `step: 'info' | 'file' | 'preview' | 'creating'`
  - 步骤 1：看板名称（≤60）、描述、主题色（复用 `BOARD_COLORS`）、「下载 Excel 模板」按钮 → `buildTemplateBytes()` → `api.saveBinaryFile({ fileName: TEMPLATE_FILE_NAME, base64 })`
  - 步骤 2：`<input type="file" accept=".xlsx,.csv">` + 拖拽区；解析中 spinner
  - 步骤 3：统计条 + 看板列清单 + 前 50 行预览表 + 错误行明细
  - 步骤 4：进度文案 `正在创建 N/M`；成功后 `navigate('/board/' + board.id)`
- [ ] **Step 2: 实现生成逻辑**
  ```ts
  const created = await createBoardWithLists({ title, description, color, listTitles: result.listTitles });
  const listByTitle = new Map(created.lists.map((l) => [l.title, l.id]));
  for (const [index, card] of result.cards.entries()) {
    const listId = listByTitle.get(card.listTitle);
    if (!listId) throw new Error(`看板列「${card.listTitle}」缺失`);
    const made = await createCard({ boardId: created.board.id, listId, title: card.title, description: card.description, startDate: card.startDate, dueDate: card.dueDate, priority: card.priority, labels: card.labels, estimatedMinutes: card.estimatedMinutes });
    if (!made) throw new Error('创建任务失败');
    setProgress({ done: index + 1, total: result.cards.length });
  }
  ```
  - 任一步失败：`await api.deleteBoard({ id: created.board.id })` → 提示原因
- [ ] **Step 3: 写 `src/pages/import.css`**，样式对齐 `src/pages/requirement.css` 的变量与命名（`imp-*` 前缀）
- [ ] **Step 4: 提交**
  ```bash
  git add src/pages/ImportPage.tsx src/pages/import.css
  git commit -m "feat(v0.15.0): 新增 Excel 导入看板向导页"
  ```

---

### Task 6: 路由、侧边栏与工作台入口

**Files:**
- Modify: `src/App.tsx`（`import { ImportPage }` + `<Route path="/import" element={<ImportPage />} />`）
- Modify: `src/components/Sidebar.tsx`（`WORKSPACE_NAV` 增加 `{ to: '/import', label: '导入看板', icon: 'upload' }`）
- Modify: `src/pages/WorkbenchPage.tsx`（「新建看板」按钮旁加「导入 Excel」→ `navigate('/import')`）

**Interfaces:**
- Consumes: `ImportPage` 组件
- Produces: 路由 `/import`

- [ ] **Step 1: 确认 `Icon` 组件是否已有 `upload`/`download` 图标名**，没有则用现有最接近的图标名（如 `file-text`）
- [ ] **Step 2: 改三处入口**
- [ ] **Step 3: 类型校验 + 构建**
  Run: `pnpm typecheck && pnpm build`
  Expected: 全部通过
- [ ] **Step 4: 提交**
  ```bash
  git add src/App.tsx src/components/Sidebar.tsx src/pages/WorkbenchPage.tsx
  git commit -m "feat(v0.15.0): 接入导入看板页面入口"
  ```

---

### Task 7: 全量验证与文档

**Files:**
- Modify: `docs/更新记录.md`、`README.md`
- Modify: `package.json`（exceljs 已在 Task 0 由 `pnpm add` 写入）

**Interfaces:**
- Produces: 变更记录条目

- [ ] **Step 1: 全量校验**
  Run: `pnpm typecheck && pnpm test && pnpm build`
  Expected: 全部通过
- [ ] **Step 2: 端到端手工验证**（浏览器开发模式 `pnpm dev`）
  - 下载模板 → 填 3 行数据（含中文日期、多标签、1.5h 工时）→ 导入 → 校验看板列顺序与任务字段
  - 故意留一行空标题 → 确认错误行计数且其余任务正常导入
- [ ] **Step 3: 文档**
  - `docs/更新记录.md` 增补 V0.15.0「Excel 导入生成看板」条目
  - `README.md` 功能清单补一行
- [ ] **Step 4: 提交**
  ```bash
  git add docs README.md package.json pnpm-lock.yaml
  git commit -m "docs(v0.15.0): 补充 Excel 导入功能说明"
  ```

---

## Self-Review

- **Spec coverage**：设计文档 §3 决策 → Task 2/3/4；§4 流程 → Task 5；§5 模板 → Task 2；§6 解析规则 → Task 1；§7 写入路径 → Task 4/5；§8 数据契约 → Task 3/4；§10 错误处理 → Task 1/2/5；§11 测试 → Task 1/7。全部覆盖。
- **Placeholder scan**：无 TBD/TODO，所有步骤给出具体函数名、字段名与命令。
- **Type consistency**：`NewBoardWithListsInput` / `CreatedBoardWithLists` / `SavedBinaryFile` 三个类型在 types.ts、api.ts、appStore.ts、models.rs 中命名一致（Rust 侧 snake_case，serde `rename_all = "camelCase"`）。
