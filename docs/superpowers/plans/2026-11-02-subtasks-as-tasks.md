# 子任务升级为真实任务（任务树）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `cards.subtasks` JSON 清单升级为 `cards.parent_card_id` 自引用的任务树，使子任务拥有与主任务一致的任务详情/元数据，并完成 schema v19 迁移、备份兼容与所有视图口径适配。

**Architecture:** 扁平快照 + 前端 `taskTree` 建树；子任务即卡片（任意层级），详情复用 `TaskDrawer`，跨任务视图只取根任务；旧 JSON 子任务在 schema 迁移与旧备份导入时展开为真实卡片，回收站按子树递归处理。

**Tech Stack:** React 18 + TypeScript + Vite + Zustand；Tauri 2 + Rust + rusqlite（SQLite）；Vitest；cargo test。

**Spec:** `docs/superpowers/specs/2026-11-02-subtasks-as-tasks-design.md`

## Global Constraints

- 版本号 V0.14.0；schema v19；备份 formatVersion 保持 1。
- 子任务与父任务必须同 `board_id`；子任务 `list_id` 必须等于父任务 `list_id`；技术深度上限 100。
- 看板/甘特/日历/筛选/我的任务/工作台/仪表盘/看板集/目标只统计根任务（`parentCardId === null`）；表格与搜索包含子任务；回收站按子树处理。
- 子任务详情隐藏「卡片颜色 / 重复任务」，「所属列表」只读。
- 每完成一个任务运行对应测试；全部完成后跑 `pnpm typecheck`、`pnpm test`、`cargo test --manifest-path src-tauri/Cargo.toml`。
- 构建安装包时若 crates.io 直连超时，临时创建 `.cargo/config.toml` 指向 rsproxy 镜像，完成后删除，不得提交。
- 提交信息使用 `feat(v0.14.0): …` / `test(v0.14.0): …`，每个任务一个提交。

## Review Focus

1. **旧数据迁移**：旧库/旧备份里 `subtasks` 顺序、完成状态、父任务进度必须原样保留，重复执行迁移不得产生重复子任务。
2. **递归删除/恢复**：删除主任务后整树进回收站；恢复主任务整树回来；单独删除子任务后父任务进度分母同步减少；彻底删除连带子树。
3. **任意层级**：3 层以上子任务在详情、表格、面包屑中缩进与导航正确，不出现死循环/丢层。
4. **脏数据防护**：跨看板父任务、自指、成环、深度超限、缺父任务的迁移/备份导入必须报错且不写入半套数据。
5. **不重复计数**：仪表盘、我的任务、看板集、目标进度在存在子任务时不把子任务当独立任务统计；看板不渲染子任务卡片。

---

### Task 0: 冻结并提交 V0.13.2 存量改动

**Files:**
- Modify: 无（仅 git 操作）
- Test: 无

**Interfaces:**
- Consumes: 当前工作区里 V0.13.2「周末加班未出勤」改动与已生成的安装包。
- Produces: 干净基线，后续任务可独立提交。

- [ ] **Step 1: 确认工作区状态**

Run: `git status --short`
Expected: 仅 V0.13.2 相关修改 + `?? src/lib/api.overtime.test.ts` + 本 spec/plan 文档；无 `.cargo/`（已删除）。

- [ ] **Step 2: 提交 V0.13.2 功能与校验值**

```bash
git add -A
git commit -m "feat(v0.13.2): 周末加班支持未出勤并记录原因，附 V0.14.0 设计与实施计划"
git status --short
```

Expected: 无输出（spec/plan 文档也已随该提交入库）。

- [ ] **Step 3: 确认基线干净**

Run: `git status --short`
Expected: 无输出。

---

### Task 1: 前端任务树纯函数与 Card 类型

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/taskTree.ts`
- Create: `src/lib/taskTree.test.ts`
- Modify: `src/lib/api.ts`、`src/lib/backup.ts`（仅类型编译修复，行为在 Task 4 完成）

**Interfaces:**
- Consumes: `Card`（`parentCardId: string | null`）。
- Produces:
  - `rootCards(cards: Card[]): Card[]`
  - `childrenOf(cards: Card[], parentId: string): Card[]`
  - `descendantsOf(cards: Card[], cardId: string): Card[]`
  - `isSubtask(card: Card): boolean`
  - `subtaskProgress(cards: Card[], cardId: string): { done: number; total: number; percent: number }`
  - `breadcrumbOf(cards: Card[], cardId: string): Card[]`
  - `cardDepth(cards: Card[], cardId: string): number`
  - `MAX_TASK_DEPTH = 100`

**兼容策略（重要）：** 本任务**不删除** `Card.subtasks` / `Subtask`，先给 `Subtask` 标注 `@deprecated`、`Card` 增加 `parentCardId`，保证中间态测试全绿；Task 8 完成自动化/模板/需求拆解适配后再统一删除 `subtasks` 字段并清理引用。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/taskTree.test.ts
import { describe, expect, it } from 'vitest';
import {
  breadcrumbOf, cardDepth, childrenOf, descendantsOf, isSubtask,
  rootCards, subtaskProgress,
} from './taskTree';
import type { Card } from './types';

const base = (id: string, parentCardId: string | null = null, completed = false): Card => ({
  id, boardId: 'b1', listId: 'l1', title: id, description: '',
  dueDate: null, startDate: null, estimatedMinutes: null, actualMinutes: null,
  priority: null, accent: null, completed, deletedAt: null, labels: [],
  position: 0, recurrenceId: null, generatedFromId: null,
  parentCardId, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

describe('taskTree', () => {
  const cards = [
    base('a'), base('a1', 'a'), base('a11', 'a1', true), base('a2', 'a', true), base('b'),
  ];

  it('区分根任务与子任务', () => {
    expect(rootCards(cards).map((card) => card.id)).toEqual(['a', 'b']);
    expect(childrenOf(cards, 'a').map((card) => card.id)).toEqual(['a1', 'a2']);
    expect(isSubtask(cards[1])).toBe(true);
  });

  it('按全部后代计算进度', () => {
    expect(descendantsOf(cards, 'a').map((card) => card.id)).toEqual(['a1', 'a11', 'a2']);
    expect(subtaskProgress(cards, 'a')).toMatchObject({ done: 2, total: 3 });
    expect(subtaskProgress(cards, 'a1')).toMatchObject({ done: 1, total: 1 });
  });

  it('面包屑从根到当前，深度正确', () => {
    expect(breadcrumbOf(cards, 'a11').map((card) => card.id)).toEqual(['a', 'a1', 'a11']);
    expect(cardDepth(cards, 'a11')).toBe(2);
    expect(breadcrumbOf(cards, 'missing')).toEqual([]);
  });

  it('容忍环数据且不无限循环', () => {
    const cyclic = [base('x', 'y'), base('y', 'x')];
    expect(() => breadcrumbOf(cyclic, 'x')).not.toThrow();
    expect(() => descendantsOf(cyclic, 'x')).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm vitest run src/lib/taskTree.test.ts`
Expected: FAIL，提示找不到 `./taskTree` 或 `parentCardId` 类型不存在。

- [ ] **Step 3: 实现类型与纯函数**

`src/lib/types.ts`：

```ts
/** 旧版子任务清单项；V0.14.0 起仅用于旧备份/旧本地数据迁移，运行时应展开为真实卡片。 */
export interface LegacySubtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Card {
  // ...既有字段保持不动
  /** V0.14.0：父任务 id；null 表示主任务 */
  parentCardId: string | null;
  /** @deprecated V0.14.0：仅旧数据迁移读取，新代码禁止写入；Task 8 后删除 */
  subtasks: LegacySubtask[];
}
```

`src/lib/taskTree.ts`：

```ts
import type { Card } from './types';

export const MAX_TASK_DEPTH = 100;

export function subtreeIndex(cards: Card[]): Map<string, Card[]> {
  const index = new Map<string, Card[]>();
  for (const card of cards) {
    if (!card.parentCardId) continue;
    const list = index.get(card.parentCardId) ?? [];
    list.push(card);
    index.set(card.parentCardId, list);
  }
  return index;
}

export function rootCards(cards: Card[]): Card[] {
  return cards.filter((card) => card.parentCardId === null);
}

export function childrenOf(cards: Card[], parentId: string): Card[] {
  return cards
    .filter((card) => card.parentCardId === parentId)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

export function descendantsOf(cards: Card[], cardId: string): Card[] {
  const index = subtreeIndex(cards);
  const result: Card[] = [];
  const seen = new Set<string>([cardId]);
  const queue = [...(index.get(cardId) ?? [])];
  while (queue.length > 0) {
    const card = queue.shift() as Card;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    result.push(card);
    queue.push(...(index.get(card.id) ?? []));
  }
  return result;
}

export function isSubtask(card: Card): boolean {
  return card.parentCardId !== null;
}

export function subtaskProgress(cards: Card[], cardId: string) {
  const all = descendantsOf(cards, cardId);
  const done = all.filter((card) => card.completed).length;
  return { done, total: all.length, percent: all.length === 0 ? 0 : Math.round((done / all.length) * 100) };
}

export function breadcrumbOf(cards: Card[], cardId: string): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chain: Card[] = [];
  const seen = new Set<string>();
  let current = byId.get(cardId);
  while (current && !seen.has(current.id) && chain.length <= MAX_TASK_DEPTH) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentCardId ? byId.get(current.parentCardId) : undefined;
  }
  return chain;
}

export function cardDepth(cards: Card[], cardId: string): number {
  const chain = breadcrumbOf(cards, cardId);
  return chain.length === 0 ? 0 : chain.length - 1;
}
```

- [ ] **Step 4: 批量更新测试 fixture**

所有构造 `Card` 的测试文件补 `parentCardId: null`（`pnpm typecheck` 会列出全部位置）：

```bash
pnpm typecheck 2>&1 | Select-String "property 'parentCardId' is missing"
```

涉及但不限于：`src/lib/dashboard.test.ts`、`dependencies.test.ts`、`goals.test.ts`、`backup.test.ts`、`automation.test.ts`、`api.*.test.ts`、`src/features/board/group.test.ts`、`filters.test.ts`、`filters.savedViews.test.ts`。`subtasks: []` 暂时保留。

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run src/lib/taskTree.test.ts && pnpm typecheck && pnpm test`
Expected: 新增测试 PASS，既有 224 项不回归。

- [ ] **Step 6: 提交**

```bash
git add src/lib/types.ts src/lib/taskTree.ts src/lib/taskTree.test.ts src/lib/api.ts src/lib/backup.ts src
git commit -m "feat(v0.14.0): 任务树纯函数与 parentCardId 类型"
```

---

### Task 2: Rust schema v19、迁移与 task tree 语义

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/repo.rs`
- Modify: `src-tauri/src/automation.rs`（子任务禁止重复配置）
- Test: 同上文件内 `#[cfg(test)]` 模块

**Interfaces:**
- Consumes: `Card`/`NewCardInput` 增加 `parent_card_id: Option<String>`；`MAX_TASK_DEPTH = 100`。
- Produces:
  - `CARD_COLUMNS` 含 `parent_card_id`；`row_to_card` 读取。
  - `create_card` 校验父任务存在、同看板、列表一致、深度 < 100；子任务位置追加到同级末尾。
  - `update_card`：子任务 `list_id` 变更报错。
  - `move_card`：子任务报错；主任务同步整棵子树 `list_id`。
  - `delete_card`/`restore_card` 递归子树；`purge_card` 由外键级联。
  - `create_recurrence`：`parent_card_id` 非空时报错「子任务不支持重复任务」。
  - `migrate_schema` 中 `expand_legacy_subtasks`（v19 迁移）。

- [ ] **Step 1: 写失败测试**

在 `repo.rs` 的 `mod tests` 内追加（可用现有 `memory_db`/`new_board`/`new_list`/`id_input` 辅助函数）：

```rust
fn new_subtask(
    conn: &mut Connection,
    board_id: &str,
    list_id: &str,
    title: &str,
    parent_id: &str,
) -> Card {
    create_card(
        conn,
        NewCardInput {
            board_id: board_id.to_string(),
            list_id: list_id.to_string(),
            title: title.to_string(),
            parent_card_id: Some(parent_id.to_string()),
            ..Default::default()
        },
    )
    .expect("创建子任务失败")
}

#[test]
fn subtask_tree_create_move_and_validate() {
    let mut conn = memory_db();
    let board = new_board(&mut conn, "看板");
    let list = new_list(&mut conn, &board.id, "待办");
    let other = new_list(&mut conn, &board.id, "进行中");
    let parent = new_card(&mut conn, &board.id, &list.id, "父任务");
    let child = new_subtask(&mut conn, &board.id, &list.id, "子任务", &parent.id);
    let grand = new_subtask(&mut conn, &board.id, &list.id, "孙任务", &child.id);
    assert_eq!(child.parent_card_id.as_deref(), Some(parent.id.as_str()));

    move_card(
        &mut conn,
        MoveCardInput {
            card_id: parent.id.clone(),
            to_list_id: other.id.clone(),
            to_index: 0,
        },
    )
    .expect("移动父任务");

    let snapshot = get_snapshot(&conn).expect("快照");
    for id in [&child.id, &grand.id] {
        let item = snapshot.cards.iter().find(|card| &card.id == id).expect("子任务存在");
        assert_eq!(item.list_id, other.id, "子任务应跟随父任务列表");
    }

    let child_move = move_card(
        &mut conn,
        MoveCardInput {
            card_id: child.id.clone(),
            to_list_id: list.id.clone(),
            to_index: 0,
        },
    )
    .expect_err("子任务不能单独移动列表");
    assert!(child_move.contains("子任务"), "错误：{child_move}");

    let child_patch = update_card(
        &mut conn,
        UpdateCardInput {
            id: child.id.clone(),
            patch: CardPatch {
                list_id: Some(list.id.clone()),
                ..Default::default()
            },
        },
    )
    .expect_err("子任务不能通过 patch 换列表");
    assert!(child_patch.contains("子任务"), "错误：{child_patch}");

    let cross_board = new_board(&mut conn, "另一个看板");
    let cross_list = new_list(&mut conn, &cross_board.id, "待办");
    let cross = create_card(
        &mut conn,
        NewCardInput {
            board_id: cross_board.id.clone(),
            list_id: cross_list.id.clone(),
            title: "跨板子任务".to_string(),
            parent_card_id: Some(parent.id.clone()),
            ..Default::default()
        },
    )
    .expect_err("父任务不在同一看板应被拒绝");
    assert!(cross.contains("看板"), "错误：{cross}");

    let recurrence = crate::automation::create_recurrence(
        &mut conn,
        NewRecurrenceInput {
            card_id: child.id.clone(),
            frequency: RecurrenceFrequency::Daily,
            ..Default::default()
        },
    )
    .expect_err("子任务不能设置重复");
    assert!(recurrence.contains("子任务"), "错误：{recurrence}");
}

#[test]
fn deleting_parent_trashes_and_restores_subtree() {
    let mut conn = memory_db();
    let board = new_board(&mut conn, "看板");
    let list = new_list(&mut conn, &board.id, "待办");
    let parent = new_card(&mut conn, &board.id, &list.id, "父任务");
    let child = new_subtask(&mut conn, &board.id, &list.id, "子任务", &parent.id);
    let grand = new_subtask(&mut conn, &board.id, &list.id, "孙任务", &child.id);
    let ids = [&parent.id, &child.id, &grand.id];

    delete_card(&mut conn, id_input(&parent.id)).expect("删除父任务");
    let snapshot = get_snapshot(&conn).expect("快照");
    for id in ids {
        assert!(!snapshot.cards.iter().any(|card| &card.id == id), "整树应进回收站");
    }

    restore_card(&mut conn, id_input(&child.id)).expect("恢复子任务应连带父链与后代");
    let snapshot = get_snapshot(&conn).expect("快照");
    for id in ids {
        assert!(snapshot.cards.iter().any(|card| &card.id == id), "整树应恢复");
    }

    delete_card(&mut conn, id_input(&parent.id)).expect("再次删除父任务");
    purge_card(&mut conn, id_input(&parent.id)).expect("彻底删除父任务");
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id IN (?1, ?2, ?3)",
            params![&parent.id, &child.id, &grand.id],
            |row| row.get(0),
        )
        .expect("统计剩余卡片");
    assert_eq!(remaining, 0, "彻底删除应级联整树");
}
```

`db.rs` 测试：

```rust
#[test]
fn v18_database_gains_parent_card_id_and_expands_legacy_subtasks() {
    let connection = Connection::open_in_memory().expect("db");
    let v18_schema = SCHEMA.replace("    parent_card_id TEXT REFERENCES cards (id) ON DELETE CASCADE,\n", "");
    assert!(!v18_schema.contains("parent_card_id"));
    connection.execute_batch(&v18_schema).expect("v18 schema");
    connection
        .execute_batch(
            "INSERT INTO boards (id, title, created_at, updated_at) VALUES ('b', 'b', 'now', 'now');
             INSERT INTO lists (id, board_id, title, created_at) VALUES ('l', 'b', 'l', 'now');
             INSERT INTO cards (id, board_id, list_id, title, subtasks, created_at, updated_at)
               VALUES ('c', 'b', 'l', '父任务',
                 '[{\"id\":\"s1\",\"title\":\"子1\",\"done\":false},{\"id\":\"s2\",\"title\":\"子2\",\"done\":true}]',
                 'now', 'now');
             PRAGMA user_version = 18;",
        )
        .expect("seed v18");

    init(&connection).expect("迁移应成功");
    init(&connection).expect("重复迁移应幂等");

    let mut statement = connection
        .prepare(
            "SELECT title, parent_card_id, completed FROM cards \
             WHERE parent_card_id = 'c' ORDER BY position ASC",
        )
        .expect("查询子任务");
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .expect("读取子任务")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("收集子任务");
    assert_eq!(
        rows,
        vec![
            ("子1".to_string(), Some("c".to_string()), 0),
            ("子2".to_string(), Some("c".to_string()), 1),
        ]
    );

    let subtasks: String = connection
        .query_row("SELECT subtasks FROM cards WHERE id = 'c'", [], |row| row.get(0))
        .expect("读取父任务 subtasks");
    assert_eq!(subtasks, "[]");
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("读取版本");
    assert_eq!(version, SCHEMA_VERSION);
}
```

- [ ] **Step 2: 运行并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib subtask_tree_create_move_and_validate`
Expected: 编译失败（`parent_card_id` 字段不存在）。

- [ ] **Step 3: 实现 models.rs**

- `Card` 增 `#[serde(default)] pub parent_card_id: Option<String>`（放在 `list_id` 后）；`Card.subtasks` 暂时保留（Task 8 删除）。
- `NewCardInput` 增 `#[serde(default)] pub parent_card_id: Option<String>`。
- 新增 `LegacySubtask`（原 `Subtask` 重命名，仅用于旧数据/旧备份反序列化）。

- [ ] **Step 4: 实现 db.rs**

- `SCHEMA_VERSION = 19`；建表语句 `cards` 增加 `parent_card_id TEXT REFERENCES cards (id) ON DELETE CASCADE`；索引 `idx_cards_parent`。
- `migrate_schema` 中按列存在性补列；新增 `fn expand_legacy_subtasks(conn: &Connection) -> Result<(), String>`：
  1. `SELECT id, board_id, list_id, title, subtasks, updated_at FROM cards WHERE parent_card_id IS NULL AND subtasks != '[]'`；
  2. 解析 JSON 为 `Vec<LegacySubtask>`；
  3. 对每项 `INSERT OR IGNORE INTO cards (id, board_id, list_id, title, description, completed, labels, subtasks, position, parent_card_id, created_at, updated_at) VALUES ('sub_<parent>_<i>', …, ?, 0, '[]', i, parent, updated_at, updated_at)`；
  4. `UPDATE cards SET subtasks = '[]' WHERE id = parent`；
  5. 整个循环包在事务内；解析失败返回「迁移 cards.subtasks 失败」。
- 迁移在 `migrate_schema` 写 `user_version` 之前调用。

- [ ] **Step 5: 实现 repo.rs**

- `CARD_COLUMNS` 加 `parent_card_id`；`row_to_card` 读取。
- `create_card`：若 `input.parent_card_id` 非空：
  - `let parent = get_card(&tx, parent_id)`；校验 `parent.board_id == input.board_id`、`parent.list_id == input.list_id`、深度 = 沿 parent 链数 `< 100`；`position` 取同级 `MAX(position)+1`（`WHERE parent_card_id = ? AND deleted_at IS NULL`）。
- `update_card`：若 `card.parent_card_id.is_some() && patch.list_id` 存在且不同 → `Err("子任务不能单独移动列表")`。
- `move_card`：`if card.parent_card_id.is_some() { return Err("子任务不能单独移动列表") }`；事务内 `UPDATE cards SET list_id = ? WHERE id = ? OR parent_card_id IN (子树)`；子树 id 用递归 CTE：
  ```sql
  WITH RECURSIVE subtree(id) AS (
    SELECT ?1 UNION ALL SELECT cards.id FROM cards JOIN subtree ON cards.parent_card_id = subtree.id
  ) SELECT id FROM subtree
  ```
- `delete_card`：递归更新 `deleted_at = now`（CTE 同样方式），保留幂等。
- `restore_card`：恢复自身 + 祖先链（若祖先被删） + 后代（CTE 反向），校验看板/列表存在。
- `purge_card`：`DELETE FROM cards WHERE id = ?`（外键级联子树）。

- [ ] **Step 6: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: 新增测试 PASS，原 157 项不回归。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/models.rs src-tauri/src/db.rs src-tauri/src/repo.rs
git commit -m "feat(v0.14.0): schema v19 任务树与递归语义"
```

---

### Task 3: Rust 备份迁移与校验

**Files:**
- Modify: `src-tauri/src/backup.rs`
- Test: `src-tauri/src/backup.rs` 测试模块

**Interfaces:**
- Consumes: Task 2 的 `Card.parent_card_id` 与 `MAX_TASK_DEPTH`。
- Produces: `expand_legacy_subtasks(backup: &mut BackupFile)`；`validate` 新增父链/同板/环/深度校验；`restore` 先展开后写入。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn backup_expands_legacy_subtasks_and_validates_parent_chain() {
    let mut conn = db::open_in_memory().expect("内存库");
    let card = seed(&mut conn);
    let mut backup = build(&conn).expect("构建备份");
    let mut parent = backup.cards[0].clone();
    parent.id = "p1".to_string();
    parent.parent_card_id = None;
    parent.subtasks = vec![
        Subtask { id: "s1".to_string(), title: "子1".to_string(), done: false },
        Subtask { id: "s2".to_string(), title: "子2".to_string(), done: true },
    ];
    backup.cards = vec![parent];
    assert_eq!(card.id.is_empty(), false);

    // 旧备份恢复：subtasks 展开为真实子卡片。
    let mut restored = db::open_in_memory().expect("目标内存库");
    let summary = restore(&mut restored, &backup).expect("恢复旧备份");
    assert_eq!(summary.cards, 1);
    let snapshot = repo::get_snapshot(&restored).expect("快照");
    assert_eq!(snapshot.cards.len(), 3);
    let children: Vec<_> = snapshot
        .cards
        .iter()
        .filter(|item| item.parent_card_id.as_deref() == Some("p1"))
        .collect();
    assert_eq!(children.len(), 2);
    assert_eq!(children[0].title, "子1");
    assert!(!children[0].completed);
    assert_eq!(children[1].title, "子2");
    assert!(children[1].completed);
    let parent_row = snapshot.cards.iter().find(|item| item.id == "p1").expect("父任务");
    assert!(parent_row.subtasks.is_empty(), "旧 JSON 应被清空");

    // 缺失父任务。
    let mut missing = backup.clone();
    expand_legacy_subtasks(&mut missing);
    missing.cards[1].parent_card_id = Some("missing".to_string());
    let error = validate(&missing).expect_err("缺父应被拒绝");
    assert!(error.contains("父任务"), "错误：{error}");

    // 跨看板父任务。
    let mut cross = backup.clone();
    expand_legacy_subtasks(&mut cross);
    let parent_board = cross.cards[0].board_id.clone();
    cross.cards[1].board_id = format!("{parent_board}_other");
    let error = validate(&cross).expect_err("跨看板应被拒绝");
    assert!(error.contains("看板"), "错误：{error}");

    // 成环。
    let mut cyclic = backup.clone();
    expand_legacy_subtasks(&mut cyclic);
    let child_id = cyclic.cards[1].id.clone();
    cyclic.cards[0].parent_card_id = Some(child_id);
    let error = validate(&cyclic).expect_err("成环应被拒绝");
    assert!(error.contains("循环"), "错误：{error}");

    // 深度 101。
    let mut deep = backup.clone();
    expand_legacy_subtasks(&mut deep);
    let mut previous = deep.cards[0].id.clone();
    for index in 0..101 {
        let mut card = deep.cards[0].clone();
        card.id = format!("deep_{index}");
        card.parent_card_id = Some(previous.clone());
        card.subtasks.clear();
        previous = card.id.clone();
        deep.cards.push(card);
    }
    let error = validate(&deep).expect_err("层级过深应被拒绝");
    assert!(error.contains("层"), "错误：{error}");
}
```

> 若 `restore` 的返回值不是 `BackupSummary`，改为实际返回类型或直接断言快照，不要保留伪代码。

- [ ] **Step 2: 运行并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib backup_expands_legacy_subtasks_and_validates_parent_chain`
Expected: FAIL（无展开逻辑）。

- [ ] **Step 3: 实现**

- `Card` 的 `parent_card_id` 用 `#[serde(default)]`，旧备份解析为 `None`。
- `fn expand_legacy_subtasks(backup: &mut BackupFile)`：递归展开每张卡的 `subtasks`（`LegacySubtask`），生成 `Card` 追加到 `backup.cards`，id 使用 `sub_<parent>_<index>`（冲突时加 `_1`、`_2` 后缀），`parent_card_id = Some(parent.id)`，`board_id/list_id/position` 继承，`completed = done`，清空原卡 `subtasks`。
- `validate` 增加：父存在、同板、列表一致（不一致时先 repair 为父列表）、无环（沿父链 ≤ 100 步）、深度 ≤ 100。
- `restore`：开头调用 `expand_legacy_subtasks(&mut backup.clone())`，随后 validate + 写入；写入 SQL 的 `cards` 列清单加入 `parent_card_id`。

- [ ] **Step 4: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/backup.rs
git commit -m "feat(v0.14.0): 备份支持任务树与旧子任务展开"
```

---

### Task 4: 浏览器模式迁移 + TS 备份兼容

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/backup.ts`
- Test: `src/lib/backup.test.ts`、`src/lib/api.taskTree.test.ts`（新建）

**Interfaces:**
- Consumes: `taskTree`、`Card.parentCardId`、`LegacySubtask`。
- Produces:
  - `expandLegacySubtaskCards(rawCards: Array<Card & { subtasks?: LegacySubtask[] }>): Card[]`（`backup.ts` 导出，`api.ts` 复用）。
  - `loadLocalDb` 卡片映射增加 `parentCardId`，并对旧 localStorage 执行展开；`subtasks` 字段暂时输出 `[]`（Task 8 删除）。
  - `localApi.createCard` 校验父任务/同板/列表/深度；`updateCard`/`moveCard`/`deleteCard`/`restoreCard`/`purgeCard` 与 Rust 同语义。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/api.taskTree.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';

// 复用 api.overtime.test.ts 的 localStorage stub
it('浏览器模式创建子任务、递归删除与恢复', async () => {
  const board = await api.createBoard({ title: '看板' });
  const list = await api.createList({ boardId: board.id, title: '待办' });
  const parent = await api.createCard({ boardId: board.id, listId: list.id, title: '父任务' });
  const child = await api.createCard({
    boardId: board.id, listId: list.id, title: '子任务', parentCardId: parent.id,
  });
  const grand = await api.createCard({
    boardId: board.id, listId: list.id, title: '孙任务', parentCardId: child.id,
  });
  expect(child.parentCardId).toBe(parent.id);
  await expect(
    api.createCard({ boardId: board.id, listId: 'other', title: '坏', parentCardId: parent.id }),
  ).rejects.toThrow('列表');
  await api.deleteCard(parent.id);
  expect((await api.getSnapshot()).cards).toHaveLength(0);
  await api.restoreCard(child.id);
  const restored = await api.getSnapshot();
  expect(restored.cards.map((card) => card.id).sort()).toEqual([parent.id, child.id, grand.id].sort());
});
```

`backup.test.ts` 增加：旧备份 `cards[0].subtasks` 展开为子卡；脏备份（缺父/环/跨板）抛错。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm vitest run src/lib/api.taskTree.test.ts src/lib/backup.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `backup.ts`：`export interface LegacySubtask { id: string; title: string; done: boolean }`；`expandLegacySubtaskCards` 展开并返回新 cards；`parseBackup` 在卡片解析后调用展开，再校验 parent（存在/同板/无环/深度 ≤ 100），错误文案与 Rust 对齐。
- `api.ts`：`loadLocalDb` 卡片映射增加 `parentCardId`（`subtasks` 暂时输出 `[]`，Task 8 删除该字段），解析后调用 `expandLegacySubtaskCards`。
- `createCard`：父任务存在、同板、`listId === parent.listId`、深度 < 100，位置追加到同级末尾。
- `updateCard`：子任务改 `listId` → 抛「子任务不能单独移动列表」。
- `moveCard`：子任务拒绝；父任务移动时同步子树 `listId`。
- `deleteCard`：递归软删子树（`deletedAt = nowISO()`）；`restoreCard`：恢复自身 + 祖先链 + 后代；`purgeCard`：删除自身子树。

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run src/lib/api.taskTree.test.ts src/lib/backup.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/api.ts src/lib/backup.ts src/lib/backup.test.ts src/lib/api.taskTree.test.ts
git commit -m "feat(v0.14.0): 浏览器模式与备份支持任务树"
```

---

### Task 5: 任务详情任务树与子任务详情

**Files:**
- Modify: `src/components/TaskDrawer.tsx`
- Modify: `src/styles/task-drawer.css`
- Modify: `src/store/appStore.ts`（如需打开子任务详情入口）
- Test: 手动浏览器截图验收 + 现有测试回归

**Interfaces:**
- Consumes: `taskTree`、`useAppStore` 的 `createCard`/`updateCard`/`deleteCard`、`useUiStore` 的 task drawer 状态。
- Produces: TaskDrawer 支持 `stack: string[]` 导航；子任务树区块；面包屑。

- [ ] **Step 1: 梳理打开逻辑**

在 `src/store/uiStore.ts` / `TaskDrawer` 找到当前 `openCardId`；扩展为 `openCardId` + 内部历史栈 `subtaskStack`，关闭时清空。

- [ ] **Step 2: 实现树区块**

```tsx
const cards = useSnapshot().cards;
const current = cards.find((card) => card.id === cardId);
const breadcrumb = breadcrumbOf(cards, cardId);
const children = childrenOf(cards, cardId);
const progress = subtaskProgress(cards, cardId);
// 每行：checkbox（updateCard completed）、标题、状态/优先级/日期摘要、
// 铅笔按钮打开详情（pushStack）、删除按钮（deleteCard）
// 底部添加输入框：createCard({ boardId, listId: current.listId, title, parentCardId: current.id })
```

- [ ] **Step 3: 面包屑与子任务详情**

- 弹窗头部在标题上方渲染面包屑按钮，点击祖先卡片切换当前 `cardId`（`setCardId`），面包屑最后一项为当前任务。
- 子任务编辑复用同一套字段区；根据 `current.parentCardId !== null`：隐藏卡片颜色与重复任务区块，「所属列表」渲染为只读文本。
- 关闭弹窗时把栈重置到根任务，避免下次打开残留。

- [ ] **Step 4: 样式**

`task-drawer.css`：新增 `.td-tree`、`.td-tree-row`（按 depth 缩进 `padding-left: 12 + depth*14`，深度 > 6 固定）、`.td-breadcrumb`、`.td-subtask-progress` 等。

- [ ] **Step 5: 手动验收**

启动 `pnpm dev`，用浏览器 localStorage 种一棵三层任务树，截图验证：
1. 详情树缩进、面包屑返回、子任务详情隐藏颜色/重复、列表只读；
2. 子任务详情里的**自定义字段**可读取并写回（与看板字段定义联动）；
3. 子任务详情可建立/查看**任务关系**，看板不绘制涉及子任务的箭头；
4. 子任务详情**最近活动**独立记录，父任务活动区不混入子任务日志。
Expected: 截图与行为符合设计。

- [ ] **Step 6: 提交**

```bash
git add src/components/TaskDrawer.tsx src/styles/task-drawer.css src/store/uiStore.ts src/store/appStore.ts
git commit -m "feat(v0.14.0): 任务详情支持任务树与子任务详情"
```

---

### Task 6: 看板 / 表格视图适配

**Files:**
- Modify: `src/features/board/KanbanBoard.tsx`
- Modify: `src/features/board/TaskCard.tsx`
- Modify: `src/features/board/TableView.tsx`
- Modify: `src/pages/BoardPage.tsx`
- Modify: `src/features/board/table.css`、`src/pages/board.css`
- Modify: 相关测试（看板/表格 fixture 已在 Task 1 补 `parentCardId`，本任务只新增过滤断言）

**Interfaces:**
- Consumes: `rootCards`、`childrenOf`、`subtaskProgress`。
- Produces: 看板只渲染根任务；表格递归渲染子任务行。

- [ ] **Step 1: 新增看板/表格过滤断言**

给 `src/features/board/*.test.ts` 增加断言：看板列表数据只包含 `parentCardId === null` 的卡片；表格树展开顺序为父任务 → 子任务（按 position）。`Card.subtasks` 字段保留到 Task 8 再删，本任务不清理 fixture。

- [ ] **Step 2: 看板实现**

- `BoardPage`/`KanbanBoard` 取 `cards` 时先 `rootCards(cards)` 再按 list 分组；列计数使用根任务数。
- `TaskCard` 进度改为 `subtaskProgress(allCards, card.id)`（需要把完整 cards 传入，或预先在 BoardPage 计算 `progressById`）。
- 删除 `card.subtasks` 引用。

- [ ] **Step 3: 表格实现**

- 行数据改为树：根任务递归展开，深度缩进 `padding-left: 12 + depth * 14`（深度 > 6 固定）。
- `SubtaskRow` 改为 `TaskTreeRow`：checkbox 切换子任务 `completed`；点击行 `openCard(child.id)`。
- 搜索：`matchesCard` 检查标题/标签；若命中子任务，保留其父链（构建 `visibleIds` 集合）。
- 删除 `card.subtasks` 引用。

- [ ] **Step 4: 运行**

Run: `pnpm test -- src/features/board && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/features/board src/pages/BoardPage.tsx src/pages/board.css
git commit -m "feat(v0.14.0): 看板与表格适配任务树"
```

---

### Task 7: 其他视图与统计口径

**Files:**
- Modify: `src/pages/MyTasksPage.tsx`
- Modify: `src/pages/WorkbenchPage.tsx`
- Modify: `src/pages/DashboardPage.tsx`
- Modify: `src/lib/dashboard.ts`
- Modify: `src/pages/BoardSetDetailPage.tsx`
- Modify: `src/pages/GoalDetailPage.tsx`、`src/pages/GoalsPage.tsx`（选择器过滤子任务）
- Modify: `src/pages/TrashPage.tsx`
- Modify: `src/components/SearchDialog.tsx`
- Modify: `src/features/board/GanttView.tsx`、`CalendarView.tsx`、`filters.ts`
- Test: `src/lib/dashboard.test.ts` 等

**Interfaces:**
- Consumes: `rootCards`、`subtaskProgress`、`breadcrumbOf`。
- Produces: 跨任务视图统一根任务口径；搜索包含子任务；回收站子树语义。

- [ ] **Step 1: 写/改测试**

在 `src/lib/dashboard.test.ts` 追加（复用现有 `snapshot()`/`filters` helper）：

```ts
it('子任务不计入任务数，只贡献子任务完成率', () => {
  const base = snapshot();
  const root = base.cards[0];
  const childDone: Card = { ...root, id: 'sub_done', title: '子任务完成', completed: true, parentCardId: root.id };
  const grandOpen: Card = { ...root, id: 'sub_open', title: '孙任务', completed: false, parentCardId: childDone.id };
  const data = buildDashboard(
    { ...base, cards: [root, childDone, grandOpen] },
    0,
    { range: 30, now: new Date('2026-11-02T00:00:00Z') },
  );
  expect(data.kpis.total).toBe(1);
  expect(data.kpis.subtaskTotal).toBe(2);
  expect(data.kpis.subtaskDone).toBe(1);
});
```

- [ ] **Step 2: 实现**

- `MyTasks`/`Workbench`/`Dashboard`/`BoardSetDetail`/`Gantt`/`Calendar`/`filters`：入口处 `const taskCards = rootCards(snapshot.cards)`；原 `card.subtasks` 统计改 `subtaskProgress(snapshot.cards, card.id)`。
- `dashboard.ts`：所有 `snapshot.cards` 汇总点改为根任务；子任务完成率单独用全部卡片中 `parentCardId !== null` 计算。
- `Goals`：关联任务选择器过滤 `parentCardId === null`；`goalProgressDetail` 仍按已关联任务 id 计算。
- `SearchDialog`：搜索范围包含子任务；结果项显示 `breadcrumbOf(cards, card.id).map(title).join(' › ')`；打开子任务详情。
- `TrashPage`：列表显示所有被删任务；子任务行显示父任务面包屑；恢复按钮对子任务调用 `restoreCard`（API 已恢复祖先）；彻底删除对父任务级联。
- 删除所有 `card.subtasks` 引用。

- [ ] **Step 3: 运行**

Run: `pnpm test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/pages src/lib/dashboard.ts src/components/SearchDialog.tsx src/features/board
git commit -m "feat(v0.14.0): 视图与统计适配任务树口径"
```

---

### Task 8: 自动化、模板与需求拆解适配

**Files:**
- Modify: `src/lib/automation.ts`、`src/lib/automation.test.ts`
- Modify: `src-tauri/src/automation.rs`、`src-tauri/src/repo.rs`（规则执行处）
- Modify: `src/pages/RequirementPage.tsx`
- Modify: `src/pages/TemplatesPage.tsx`、`src/lib/templates.ts`
- Test: `src/lib/automation.test.ts`、`src-tauri/src/automation.rs` 测试、`src/lib/requirementPlan.test.ts`

**Interfaces:**
- Consumes: `createCard(parentCardId)`。
- Produces: `append_subtasks` 生成真实子任务卡片；模板与需求拆解 nested 模式创建子任务卡片。

- [ ] **Step 1: 写失败测试**

`src/lib/automation.test.ts`：

```ts
it('追加子任务规则返回待创建的子任务标题，不再写 JSON', () => {
  const card: Card = {
    id: 'c1', boardId: 'b1', listId: 'l1', title: '父任务', description: '',
    dueDate: null, startDate: null, estimatedMinutes: null, actualMinutes: null,
    priority: null, accent: null, completed: false, deletedAt: null, labels: [],
    subtasks: [], parentCardId: null, position: 0,
    recurrenceId: null, generatedFromId: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const outcome = applyRuleActions(
    card,
    [{ kind: 'append_subtasks', subtasks: ['第一步', '第二步'] }],
    '2026-11-02',
  );
  expect(outcome.subtaskTitles).toEqual(['第一步', '第二步']);
  expect(outcome.patch.subtasks).toBeUndefined();
});
```

`src-tauri/src/automation.rs` 测试：把现有 `append_subtasks` 断言改为 `outcome.subtask_titles == Some(vec!["第一步"])`，并断言不再产生 `subtasks` patch。

- [ ] **Step 2: 实现**

- TS `automation.ts`：`applyRuleActions` 返回值把 `subtasks` 改为 `subtaskTitles: string[]`；`api.updateCard` 在更新后为每个标题调用 `createCard({ boardId, listId: card.listId, title, parentCardId: card.id })`。
- Rust `automation.rs`：`RuleOutcome` 的 `subtasks: Option<Vec<Subtask>>` 改为 `subtask_titles: Option<Vec<String>>`；`repo::update_card` 在规则执行完成后为标题创建子卡片（同一事务）。
- `RequirementPage` nested 模式：先 `createCard` 父任务，再逐条 `createCard({ ..., parentCardId: parent.id })`；预览区子任务展示逻辑改为用返回的卡片标题。
- `TemplatesPage`：实例化模板时若模板卡有 `subtasks` 字符串数组，为每条创建子卡片（parentCardId = 新建父卡 id）。
- 更新所有相关测试 fixture 与断言。

- [ ] **Step 3: 移除 `Card.subtasks` 旧字段并清理引用**

- `src/lib/types.ts`：删除 `Card.subtasks` 字段（`LegacySubtask` 类型保留，仅供 `backup.ts`/`api.ts` 解析旧数据）。
- `src/lib/backup.ts`：定义 `type LegacyCard = Card & { subtasks?: LegacySubtask[] }`，解析时用 `LegacyCard`，展开后转成 `Card`。
- `src/lib/api.ts`：`loadLocalDb` 用 `LegacyCard` 解析，不再输出 `subtasks`。
- Rust `models.rs`：`Card.subtasks` 改为 `#[serde(default, skip_serializing)] pub subtasks: Vec<LegacySubtask>`（只为读取旧备份/旧库，新备份不再输出）；删除其余写入路径。
- 删除所有测试 fixture 里的 `subtasks: []`，`pnpm typecheck` + `pnpm test` 确认全绿。

- [ ] **Step 4: 运行**

Run: `pnpm test && pnpm typecheck && cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(v0.14.0): 自动化/模板/需求拆解生成真实子任务并移除 subtasks 字段"
```

---

### Task 9: 文档、版本与全量验证、打包

**Files:**
- Modify: `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`
- Modify: `README.md`、`docs/更新记录.md`、`docs/开发计划.md`
- Modify: `docs/发布与签名.md`（打包脚本自动写入）

**Interfaces:**
- Consumes: 前 8 个任务。
- Produces: V0.14.0 安装包与文档。

- [ ] **Step 1: 版本号与文档**

- 三处版本号改为 `0.14.0`。
- 更新记录新增 V0.14.0 条目（子任务升级为任务树、schema v19、迁移/备份兼容、视图口径）。
- 开发计划：数据模型补 `parent_card_id`、迁移条目 v19、任务详情与视图口径、验收清单。
- README：功能描述补子任务任务树；下载文件名改 `tideline-0.14.0-win64-setup.exe`；测试数量更新。

- [ ] **Step 2: 全量检查**

Run:
```bash
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 全绿；记录测试数量。

- [ ] **Step 3: 浏览器截图验收**

启动 `pnpm dev` + 临时 seed 脚本，截图：任务详情三层树、子任务详情面包屑、看板进度、表格缩进、回收站父子、搜索面包屑。Expected: 与设计一致。

- [ ] **Step 4: 构建安装包**

```bash
pnpm package
```
（若 crates.io 超时：临时 `.cargo/config.toml` 指向 rsproxy，构建后删除。）

- [ ] **Step 5: 独立验证**

交给只读验证员：全量测试、git diff 审查、安装包版本/哈希三方一致（NSIS 产物 = release 副本 = `docs/发布与签名.md`）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "release(v0.14.0): 子任务任务树与安装包校验值"
```

---

## 任务依赖

- Task 1 完成后才能开始 Task 4/5/6/7（类型与纯函数）。
- Task 2 与 Task 1 可并行（Rust / TS 独立）。
- Task 3 依赖 Task 2；Task 4 依赖 Task 1。
- Task 5/6/7 依赖 Task 4（浏览器模式与类型）；Task 8 依赖 Task 4/5。
- Task 9 依赖全部。
