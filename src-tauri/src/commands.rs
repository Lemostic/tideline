//! Tauri 命令层：命令名与前端 `src/lib/api.ts` 的 `tauriApi` 完全对应。
//!
//! 每个写入命令只接收一个 `input` 参数（`get_snapshot` 无参），
//! 加锁后把逻辑委托给 `repo`，并统一返回 `Result<T, String>`。

use tauri::State;

use crate::db::Db;
use crate::models::*;
use crate::repo;

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
