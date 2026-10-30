//! 领域模型：与前端 `src/lib/types.ts` 一一对应。
//!
//! 所有结构体都使用 `#[serde(rename_all = "camelCase")]`，保证 `invoke` 返回的
//! JSON 字段名与前端 TypeScript 类型完全一致（`boardId`、`dueDate`、`createdAt`…）。

use serde::{Deserialize, Deserializer, Serialize};

/// 看板主题色，与前端 `BoardColor` 同一组取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardColor {
    Blue,
    Amber,
    Coral,
    Green,
    Violet,
    Rose,
    Teal,
    Slate,
}

impl BoardColor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blue => "blue",
            Self::Amber => "amber",
            Self::Coral => "coral",
            Self::Green => "green",
            Self::Violet => "violet",
            Self::Rose => "rose",
            Self::Teal => "teal",
            Self::Slate => "slate",
        }
    }

    /// 从数据库文本还原；未知值兜底为蓝色，避免历史数据导致整块看板不可用。
    pub fn from_db(raw: &str) -> Self {
        match raw {
            "amber" => Self::Amber,
            "coral" => Self::Coral,
            "green" => Self::Green,
            "violet" => Self::Violet,
            "rose" => Self::Rose,
            "teal" => Self::Teal,
            "slate" => Self::Slate,
            _ => Self::Blue,
        }
    }
}

/// 卡片优先级，与前端 `Priority` 一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Medium,
    High,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn from_db(raw: &str) -> Option<Self> {
        match raw {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub title: String,
    pub description: String,
    pub color: BoardColor,
    pub starred: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub id: String,
    pub board_id: String,
    pub title: String,
    pub position: i64,
    pub created_at: String,
}

/// 任务内的子任务（清单项），在数据库里以 JSON 文本存在 `cards.subtasks`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub board_id: String,
    pub list_id: String,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    /// 甘特视图的起始日期（YYYY-MM-DD），null 表示未排期。
    pub start_date: Option<String>,
    pub priority: Option<Priority>,
    pub completed: bool,
    /// 软删除时间；非 null 表示在回收站，`get_snapshot` 不会返回这些任务。
    pub deleted_at: Option<String>,
    /// 自由标签，数据库里存 JSON 数组文本。
    pub labels: Vec<String>,
    /// 子任务清单，数据库里存 JSON 数组文本。
    pub subtasks: Vec<Subtask>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

/// 启动时一次性拉取的全量快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub boards: Vec<Board>,
    pub lists: Vec<List>,
    pub cards: Vec<Card>,
    pub inbox: Vec<InboxItem>,
}

// ---------------------------------------------------------------------------
// 备份 / 恢复（V0.4）
// ---------------------------------------------------------------------------

/// 导出的备份文件格式。`cards` 包含回收站里的任务（`deletedAt` 非空），
/// 因此恢复后回收站内容也能完整保留。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub app: String,
    pub format_version: u32,
    pub exported_at: String,
    pub boards: Vec<Board>,
    pub lists: Vec<List>,
    pub cards: Vec<Card>,
    pub inbox: Vec<InboxItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub boards: usize,
    pub lists: usize,
    pub cards: usize,
    pub trashed: usize,
    pub inbox: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExport {
    /// 备份文件写入的绝对路径（桌面端导出到「文档」目录）。
    pub path: String,
    pub summary: BackupSummary,
}

// ---------------------------------------------------------------------------
// 命令入参
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBoardInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<BoardColor>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<BoardColor>,
    #[serde(default)]
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBoardInput {
    pub id: String,
    pub patch: BoardPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewListInput {
    pub board_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPatch {
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateListInput {
    pub id: String,
    pub patch: ListPatch,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCardInput {
    pub board_id: String,
    pub list_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub subtasks: Option<Vec<Subtask>>,
}

/// 把「字段缺失」与「显式 null」区分开：
/// - 字段缺失 → `None`（保持原值，对应前端 `patch.dueDate === undefined`）
/// - 显式 null → `Some(None)`（清空，对应前端 `patch.dueDate === null`）
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub priority: Option<Option<Priority>>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub list_id: Option<String>,
    /// 标签数组：字段缺失=保持原值，传数组=整体替换。
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// 子任务数组：字段缺失=保持原值，传数组=整体替换。
    #[serde(default)]
    pub subtasks: Option<Vec<Subtask>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCardInput {
    pub id: String,
    pub patch: CardPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardInput {
    pub card_id: String,
    pub to_list_id: String,
    pub to_index: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdInput {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddInboxInput {
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertInboxInput {
    pub id: String,
    pub board_id: String,
    #[serde(default)]
    pub list_id: Option<String>,
}

/// 从前端上传的备份文件内容（JSON 文本）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBackupInput {
    pub json: String,
}

// ---------------------------------------------------------------------------
// 单元测试：锁定与前端 TypeScript 契约一致的 JSON 形态
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_card() -> Card {
        Card {
            id: "c_1".to_string(),
            board_id: "b_1".to_string(),
            list_id: "l_1".to_string(),
            title: "任务".to_string(),
            description: "".to_string(),
            due_date: Some("2026-01-10".to_string()),
            start_date: Some("2026-02-01".to_string()),
            priority: Some(Priority::High),
            completed: false,
            deleted_at: None,
            labels: vec!["研发".to_string()],
            subtasks: vec![Subtask {
                id: "s1".to_string(),
                title: "步骤".to_string(),
                done: true,
            }],
            position: 0,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn card_serializes_v02_fields_as_camel_case() {
        let json = serde_json::to_value(sample_card()).expect("序列化卡片");
        assert_eq!(json["startDate"], serde_json::json!("2026-02-01"));
        assert_eq!(json["labels"], serde_json::json!(["研发"]));
        assert_eq!(
            json["subtasks"],
            serde_json::json!([{ "id": "s1", "title": "步骤", "done": true }])
        );
        // V0.1 已有字段名保持不变
        assert_eq!(json["dueDate"], serde_json::json!("2026-01-10"));
        assert!(json.get("start_date").is_none());

        // V0.3 回收站字段：未删除时 deletedAt 为 null，且字段必须存在。
        assert_eq!(json["deletedAt"], serde_json::Value::Null);
        let mut deleted = sample_card();
        deleted.deleted_at = Some("2026-03-01T08:00:00.000Z".to_string());
        let deleted_json = serde_json::to_value(deleted).expect("序列化回收站卡片");
        assert_eq!(
            deleted_json["deletedAt"],
            serde_json::json!("2026-03-01T08:00:00.000Z")
        );
    }

    #[test]
    fn card_patch_distinguishes_missing_from_null() {
        let missing: CardPatch = serde_json::from_str("{}").expect("空 patch");
        assert_eq!(missing.start_date, None);
        assert_eq!(missing.labels, None);
        assert_eq!(missing.subtasks, None);

        let cleared: CardPatch = serde_json::from_str(r#"{"startDate": null}"#).expect("显式 null");
        assert_eq!(cleared.start_date, Some(None));

        let replaced: CardPatch = serde_json::from_str(
            r#"{"startDate": "2026-02-01", "labels": ["研发"], "subtasks": [{"id": "s1", "title": "步骤", "done": true}]}"#,
        )
        .expect("数组整体替换");
        assert_eq!(replaced.start_date, Some(Some("2026-02-01".to_string())));
        assert_eq!(replaced.labels, Some(vec!["研发".to_string()]));
        assert_eq!(
            replaced.subtasks,
            Some(vec![Subtask {
                id: "s1".to_string(),
                title: "步骤".to_string(),
                done: true,
            }])
        );
    }

    #[test]
    fn new_card_input_defaults_missing_v02_fields() {
        let input: NewCardInput =
            serde_json::from_str(r#"{"boardId":"b","listId":"l","title":"任务"}"#)
                .expect("最小输入");
        assert_eq!(input.start_date, None);
        assert_eq!(input.labels, None);
        assert_eq!(input.subtasks, None);

        let input: NewCardInput = serde_json::from_str(
            r#"{"boardId":"b","listId":"l","title":"任务","startDate":null,"labels":[],"subtasks":[]}"#,
        )
        .expect("显式空值输入");
        assert_eq!(input.start_date, None);
        assert_eq!(input.labels, Some(Vec::new()));
        assert_eq!(input.subtasks, Some(Vec::new()));
    }
}
