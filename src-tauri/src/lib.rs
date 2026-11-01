//! 潮线 tideline — Tauri 2 桌面后端入口。
//!
//! 启动时读取自定义存储目录配置（没有则用 `app_data_dir`），
//! 在目录下打开（必要时创建）`tideline.db`，把 rusqlite 连接放进
//! `Mutex` 托管给 Tauri 状态，再注册命令。
//!
//! `src-tauri/src/main.rs` 只调用这里的 `run()`。

mod autostart;
mod automation;
mod backup;
mod commands;
mod db;
mod models;
mod reminders;
mod repo;
mod storage;
mod usage;

use tauri::Manager;

use db::Db;
use usage::UsageRuntime;

/// 「桌面软件使用统计」当前处于下线状态。
///
/// 该功能统计前台软件使用时长，与潮线「任务与看板管理」的产品定位不符，
/// 因此默认不启动后台采样线程：既不在导航中出现，也不在用户无感知的情况下
/// 继续采集数据。相关表结构、命令与已有数据全部保留，需要时把这里改成
/// `true` 即可恢复。
const USAGE_STATS_ENABLED: bool = false;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 默认 %APPDATA%\com.lemostic.tideline\，可在设置里改为自定义目录
            let data_dir = storage::data_dir(app.handle())
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = storage::db_path(&data_dir);
            let connection =
                db::open(&db_path).map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            // 使用统计的运行时状态以数据库里的设置为准（暂停开关、空闲阈值）。
            let usage_settings = usage::get_settings(&connection)
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            app.manage(Db::new(connection));
            app.manage(UsageRuntime::new(
                usage_settings.paused,
                usage_settings.idle_threshold_seconds,
            ));
            // 启动后台采样线程：每 1 秒采样一次前台窗口所属进程，线程随进程退出而结束。
            // 使用统计下线时不启动，避免在用户无感知的情况下继续采集前台窗口数据。
            if USAGE_STATS_ENABLED {
                usage::spawn_sampler(app.handle().clone());
            }
            // 启动后台提醒线程：每分钟检查一次到期 / 逾期 / 每日摘要。
            reminders::spawn_scheduler(app.handle().clone());
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
            commands::set_card_dependencies,
            commands::create_board_set,
            commands::update_board_set,
            commands::delete_board_set,
            commands::create_goal,
            commands::update_goal,
            commands::delete_goal,
            commands::open_external,
            commands::get_autostart,
            commands::set_autostart,
            commands::create_team_member,
            commands::update_team_member,
            commands::delete_team_member,
            commands::create_tenure,
            commands::update_tenure,
            commands::delete_tenure,
            commands::create_overtime,
            commands::update_overtime,
            commands::delete_overtime,
            commands::create_performance,
            commands::update_performance,
            commands::delete_performance,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::create_project_meta,
            commands::update_project_meta,
            commands::delete_project_meta,
            commands::create_project_role,
            commands::update_project_role,
            commands::delete_project_role,
            commands::export_backup,
            commands::import_backup,
            commands::get_storage_info,
            commands::pick_data_directory,
            commands::change_data_directory,
            commands::reset_data_directory,
            commands::pick_requirement_file,
            commands::get_usage_overview,
            commands::get_usage_apps,
            commands::set_usage_app_included,
            commands::get_usage_settings,
            commands::set_usage_settings,
            commands::clear_usage_records,
            commands::get_card_activity,
            commands::get_recurrences,
            commands::create_recurrence,
            commands::update_recurrence,
            commands::delete_recurrence,
            commands::get_automation_rules,
            commands::create_automation_rule,
            commands::update_automation_rule,
            commands::delete_automation_rule,
            commands::get_notification_settings,
            commands::set_notification_settings,
        ])
        .run(tauri::generate_context!())
        .expect("启动潮线 tideline 失败");
}
