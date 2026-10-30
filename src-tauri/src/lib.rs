//! 潮线 tideline — Tauri 2 桌面后端入口。
//!
//! 启动时在 `app_data_dir` 下打开（必要时创建）`tideline.db`，
//! 把 rusqlite 连接放进 `Mutex` 托管给 Tauri 状态，再注册 18 个命令。
//!
//! `src-tauri/src/main.rs` 只调用这里的 `run()`。

mod commands;
mod db;
mod models;
mod repo;

use tauri::Manager;

use db::Db;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Windows 上解析为 %APPDATA%\com.lemostic.tideline\
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("tideline.db");
            let connection =
                db::open(&db_path).map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            app.manage(Db::new(connection));
            #[cfg(debug_assertions)]
            eprintln!("[tideline] SQLite 数据库：{}", db_path.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::create_board,
            commands::update_board,
            commands::delete_board,
            commands::create_list,
            commands::update_list,
            commands::delete_list,
            commands::create_card,
            commands::update_card,
            commands::delete_card,
            commands::move_card,
            commands::get_trash,
            commands::restore_card,
            commands::purge_card,
            commands::empty_trash,
            commands::add_inbox_item,
            commands::delete_inbox_item,
            commands::convert_inbox_item,
        ])
        .run(tauri::generate_context!())
        .expect("启动潮线 tideline 失败");
}
