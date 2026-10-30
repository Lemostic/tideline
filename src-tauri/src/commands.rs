//! Tauri 命令层：命令名与前端 `src/lib/api.ts` 的 `tauriApi` 完全对应。
//!
//! 每个写入命令只接收一个 `input` 参数（`get_snapshot` 无参），
//! 加锁后把逻辑委托给 `repo`，并统一返回 `Result<T, String>`。

use tauri::{AppHandle, State};

use crate::backup;
use crate::db::Db;
use crate::models::*;
use crate::repo;
use crate::storage;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn get_snapshot(db: State<'_, Db>) -> CmdResult<Snapshot> {
    let conn = db.lock()?;
    repo::get_snapshot(&conn)
}

#[tauri::command]
pub fn create_board(db: State<'_, Db>, input: NewBoardInput) -> CmdResult<Board> {
    let mut conn = db.lock()?;
    repo::create_board(&mut conn, input)
}

#[tauri::command]
pub fn update_board(db: State<'_, Db>, input: UpdateBoardInput) -> CmdResult<Board> {
    let mut conn = db.lock()?;
    repo::update_board(&mut conn, input)
}

#[tauri::command]
pub fn delete_board(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::delete_board(&mut conn, input)
}

#[tauri::command]
pub fn create_list(db: State<'_, Db>, input: NewListInput) -> CmdResult<List> {
    let mut conn = db.lock()?;
    repo::create_list(&mut conn, input)
}

#[tauri::command]
pub fn update_list(db: State<'_, Db>, input: UpdateListInput) -> CmdResult<List> {
    let mut conn = db.lock()?;
    repo::update_list(&mut conn, input)
}

#[tauri::command]
pub fn delete_list(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::delete_list(&mut conn, input)
}

#[tauri::command]
pub fn create_card(db: State<'_, Db>, input: NewCardInput) -> CmdResult<Card> {
    let mut conn = db.lock()?;
    repo::create_card(&mut conn, input)
}

#[tauri::command]
pub fn update_card(db: State<'_, Db>, input: UpdateCardInput) -> CmdResult<Card> {
    let mut conn = db.lock()?;
    repo::update_card(&mut conn, input)
}

#[tauri::command]
pub fn delete_card(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::delete_card(&mut conn, input)
}

#[tauri::command]
pub fn move_card(db: State<'_, Db>, input: MoveCardInput) -> CmdResult<Card> {
    let mut conn = db.lock()?;
    repo::move_card(&mut conn, input)
}

// ---------------------------------------------------------------------------
// 回收站（V0.3）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_trash(db: State<'_, Db>) -> CmdResult<Vec<Card>> {
    let conn = db.lock()?;
    repo::get_trash(&conn)
}

#[tauri::command]
pub fn restore_card(db: State<'_, Db>, input: IdInput) -> CmdResult<Card> {
    let mut conn = db.lock()?;
    repo::restore_card(&mut conn, input)
}

#[tauri::command]
pub fn purge_card(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::purge_card(&mut conn, input)
}

#[tauri::command]
pub fn empty_trash(db: State<'_, Db>) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::empty_trash(&mut conn)
}

#[tauri::command]
pub fn add_inbox_item(db: State<'_, Db>, input: AddInboxInput) -> CmdResult<InboxItem> {
    let mut conn = db.lock()?;
    repo::add_inbox_item(&mut conn, input)
}

#[tauri::command]
pub fn delete_inbox_item(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::delete_inbox_item(&mut conn, input)
}

#[tauri::command]
pub fn convert_inbox_item(db: State<'_, Db>, input: ConvertInboxInput) -> CmdResult<Card> {
    let mut conn = db.lock()?;
    repo::convert_inbox_item(&mut conn, input)
}

// ---------------------------------------------------------------------------
// 任务依赖（V0.4）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_card_dependencies(
    db: State<'_, Db>,
    input: SetDependenciesInput,
) -> CmdResult<Vec<CardDependency>> {
    let mut conn = db.lock()?;
    repo::set_card_dependencies(&mut conn, input)
}

// ---------------------------------------------------------------------------
// 看板集（V0.5.4）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_board_set(db: State<'_, Db>, input: NewBoardSetInput) -> CmdResult<BoardSet> {
    let mut conn = db.lock()?;
    repo::create_board_set(&mut conn, input)
}

#[tauri::command]
pub fn update_board_set(db: State<'_, Db>, input: UpdateBoardSetInput) -> CmdResult<BoardSet> {
    let mut conn = db.lock()?;
    repo::update_board_set(&mut conn, input)
}

#[tauri::command]
pub fn delete_board_set(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::delete_board_set(&mut conn, input)
}

// ---------------------------------------------------------------------------
// 目标（V0.6）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_goal(db: State<'_, Db>, input: NewGoalInput) -> CmdResult<Goal> {
    let mut conn = db.lock()?;
    repo::create_goal(&mut conn, input)
}

#[tauri::command]
pub fn update_goal(db: State<'_, Db>, input: UpdateGoalInput) -> CmdResult<Goal> {
    let mut conn = db.lock()?;
    repo::update_goal(&mut conn, input)
}

#[tauri::command]
pub fn delete_goal(db: State<'_, Db>, input: IdInput) -> CmdResult<()> {
    let mut conn = db.lock()?;
    repo::delete_goal(&mut conn, input)
}

// ---------------------------------------------------------------------------
// 备份 / 恢复（V0.4）
// ---------------------------------------------------------------------------

/// 导出全量 JSON 备份到用户「文档」目录，返回实际文件路径与统计。
#[tauri::command]
pub fn export_backup(db: State<'_, Db>) -> CmdResult<BackupExport> {
    let conn = db.lock()?;
    let backup = backup::build(&conn)?;
    let json = serde_json::to_string_pretty(&backup)
        .map_err(|error| format!("备份序列化失败：{error}"))?;
    let path = backup::default_export_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建备份目录失败：{error}"))?;
    }
    std::fs::write(&path, json).map_err(|error| format!("写入备份文件失败：{error}"))?;
    Ok(BackupExport {
        path: path.to_string_lossy().into_owned(),
        summary: backup.summary(),
    })
}

/// 从 JSON 文本恢复全量数据；校验失败或写入失败时事务回滚。
#[tauri::command]
pub fn import_backup(db: State<'_, Db>, input: ImportBackupInput) -> CmdResult<BackupSummary> {
    // 本地单机工具的备份不会太大，限制上限避免误选超大文件把进程卡死。
    if input.json.len() > 100 * 1024 * 1024 {
        return Err("备份文件超过 100MB，已拒绝导入".to_string());
    }
    let backup: BackupFile = serde_json::from_str(&input.json)
        .map_err(|error| format!("备份文件不是有效的 JSON：{error}"))?;
    let mut conn = db.lock()?;
    backup::restore(&mut conn, &backup)
}

// ---------------------------------------------------------------------------
// 数据存储目录（V0.5）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_storage_info(app: AppHandle) -> CmdResult<storage::StorageInfo> {
    storage::info(&app)
}

/// 打开原生文件夹选择框；取消返回 null。
#[tauri::command]
pub fn pick_data_directory(app: AppHandle) -> CmdResult<Option<String>> {
    Ok(storage::pick_folder(&app).map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn change_data_directory(
    app: AppHandle,
    db: State<'_, Db>,
    input: ChangeDataDirInput,
) -> CmdResult<storage::StorageInfo> {
    storage::change_data_directory(&app, &db, std::path::Path::new(input.path.trim()))
}

#[tauri::command]
pub fn reset_data_directory(
    app: AppHandle,
    db: State<'_, Db>,
) -> CmdResult<storage::StorageInfo> {
    let target = storage::default_dir(&app)?;
    storage::change_data_directory(&app, &db, &target)
}
