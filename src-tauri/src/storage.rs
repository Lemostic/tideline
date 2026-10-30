//! 自定义数据存储目录。
//!
//! 数据库默认位于 `%APPDATA%\com.lemostic.tideline\tideline.db`；
//! 用户可以在设置里选择其它目录，目录配置写在默认应用数据目录的
//! `storage.json` 中，保证下次启动能找到自定义位置。
//!
//! 切换目录时：checkpoint WAL → 关闭连接 → 复制数据库文件到新目录 →
//! 用新目录打开并迁移 → 写入配置 → 删除旧文件；任一步失败都会回滚到原目录。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::{self, Db};

const DB_FILE: &str = "tideline.db";
const DB_SIDECARS: [&str; 2] = ["tideline.db-wal", "tideline.db-shm"];
const CONFIG_FILE: &str = "storage.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StorageConfig {
    #[serde(default)]
    data_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub data_dir: String,
    pub db_path: String,
    pub default_dir: String,
    pub is_custom: bool,
    /// 浏览器 localStorage 模式无法自定义路径，前端据此隐藏入口
    pub editable: bool,
}

/// 默认应用数据目录：Windows 上为 `%APPDATA%\com.lemostic.tideline`。
pub fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("读取应用数据目录失败：{error}"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(default_dir(app)?.join(CONFIG_FILE))
}

fn read_config(app: &AppHandle) -> StorageConfig {
    let Ok(path) = config_path(app) else {
        return StorageConfig::default();
    };
    load_config_from(&path)
}

fn load_config_from(path: &Path) -> StorageConfig {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, data_dir: Option<&Path>) -> Result<(), String> {
    save_config_to(&config_path(app)?, data_dir)
}

fn save_config_to(path: &Path, data_dir: Option<&Path>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let config = StorageConfig {
        data_dir: data_dir.map(|dir| dir.to_string_lossy().into_owned()),
    };
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("序列化存储配置失败：{error}"))?;
    fs::write(path, json).map_err(|error| format!("写入存储配置失败：{error}"))
}

fn resolve_data_dir(config: &StorageConfig, default: &Path) -> PathBuf {
    match config.data_dir.as_deref().map(PathBuf::from) {
        Some(dir) if !dir.as_os_str().is_empty() => {
            if dir.is_absolute() {
                dir
            } else {
                default.join(dir)
            }
        }
        _ => default.to_path_buf(),
    }
}

/// 当前使用的数据目录（绝对路径）；未配置时回落到默认目录。
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let default = default_dir(app)?;
    Ok(resolve_data_dir(&read_config(app), &default))
}

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}

pub fn info(app: &AppHandle) -> Result<StorageInfo, String> {
    let default = default_dir(app)?;
    let current = data_dir(app)?;
    let is_custom = normalize_for_compare(&current) != normalize_for_compare(&default);
    Ok(StorageInfo {
        data_dir: current.to_string_lossy().into_owned(),
        db_path: db_path(&current).to_string_lossy().into_owned(),
        default_dir: default.to_string_lossy().into_owned(),
        is_custom,
        editable: true,
    })
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn copy_database_files(from: &Path, to: &Path) -> Result<(), String> {
    let source = db_path(from);
    if !source.is_file() {
        return Err(format!("当前数据文件不存在：{}", source.display()));
    }
    fs::copy(&source, db_path(to))
        .map_err(|error| format!("复制数据库到新目录失败：{error}"))?;
    for sidecar in DB_SIDECARS {
        let source_sidecar = from.join(sidecar);
        if source_sidecar.exists() {
            fs::copy(&source_sidecar, to.join(sidecar))
                .map_err(|error| format!("复制数据库附属文件失败：{error}"))?;
        }
    }
    Ok(())
}

fn remove_database_files(dir: &Path) {
    let _ = fs::remove_file(db_path(dir));
    for sidecar in DB_SIDECARS {
        let _ = fs::remove_file(dir.join(sidecar));
    }
}

fn reopen_old(db: &Db, old_dir: &Path) {
    if let Ok(connection) = db::open(&db_path(old_dir)) {
        let _ = db.put(connection);
    }
}

/// 把数据库迁移到目标目录并切换当前连接。
///
/// 目标目录必须可写且不能已存在 `tideline.db`（避免覆盖别人的数据）。
/// 整个切换过程会短暂关闭数据库连接；失败时自动回滚并重新打开原数据库。
pub fn change_data_directory(
    app: &AppHandle,
    db: &Db,
    target: &Path,
) -> Result<StorageInfo, String> {
    let default = default_dir(app)?;
    let current = data_dir(app)?;
    let target = target.to_path_buf();
    if !target.is_absolute() {
        return Err("数据目录必须是绝对路径".to_string());
    }
    fs::create_dir_all(&target).map_err(|error| format!("创建目标目录失败：{error}"))?;
    let current_norm = normalize_for_compare(&current);
    let target_norm = normalize_for_compare(&target);
    if current_norm == target_norm {
        return info(app);
    }
    if db_path(&target).exists() {
        return Err("目标目录中已经存在 tideline.db，请选择一个空目录".to_string());
    }

    migrate_database(&current, &target, db)?;

    let custom = target_norm != normalize_for_compare(&default);
    if let Err(error) = save_config(app, if custom { Some(&target) } else { None }) {
        // 配置写入失败：撤销切换，继续使用原目录。
        if let Ok(connection) = db.take() {
            drop(connection);
        }
        remove_database_files(&target);
        reopen_old(db, &current);
        return Err(error);
    }

    // 配置已指向新目录，旧目录中的数据库文件可以安全清理。
    remove_database_files(&current);
    info(app)
}

/// 数据库文件迁移核心：checkpoint → 关旧连接 → 复制 → 打开新连接。
///
/// 不写配置、不删除旧数据库文件，方便调用方在配置失败时回滚；
/// 旧目录的数据库文件由 `change_data_directory` 在切换成功后清理。
fn migrate_database(current: &Path, target: &Path, db: &Db) -> Result<(), String> {
    // 先把 WAL 写回主库，再关连接，保证复制出的 .db 是完整快照。
    {
        let connection = db.lock()?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| format!("整理数据库失败：{error}"))?;
    }
    let old_connection = db.take()?;
    drop(old_connection);

    if let Err(error) = copy_database_files(current, target) {
        remove_database_files(target);
        reopen_old(db, current);
        return Err(error);
    }

    let new_connection = match db::open(&db_path(target)) {
        Ok(connection) => connection,
        Err(error) => {
            remove_database_files(target);
            reopen_old(db, current);
            return Err(format!("打开新目录数据库失败：{error}"));
        }
    };
    if let Err(error) = db.put(new_connection) {
        remove_database_files(target);
        reopen_old(db, current);
        return Err(error);
    }
    Ok(())
}

/// 打开系统文件夹选择框；返回绝对路径，取消时返回 None。
pub fn pick_folder(app: &AppHandle) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title("选择数据存储目录");
    if let Ok(current) = data_dir(app) {
        dialog = dialog.set_directory(current);
    }
    dialog.pick_folder()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("tideline-{prefix}-{stamp}"));
        fs::create_dir_all(&path).expect("创建临时目录");
        path
    }

    #[test]
    fn copy_database_files_includes_main_and_wal_sidecars() {
        let from = temp_dir("storage-from");
        let to = temp_dir("storage-to");
        fs::write(db_path(&from), b"main-db").expect("写主库");
        fs::write(from.join("tideline.db-wal"), b"wal").expect("写 WAL");
        fs::write(from.join("tideline.db-shm"), b"shm").expect("写 SHM");

        copy_database_files(&from, &to).expect("复制数据库");
        assert_eq!(fs::read(db_path(&to)).expect("读主库"), b"main-db");
        assert_eq!(
            fs::read(to.join("tideline.db-wal")).expect("读 WAL"),
            b"wal"
        );
        assert_eq!(
            fs::read(to.join("tideline.db-shm")).expect("读 SHM"),
            b"shm"
        );

        remove_database_files(&from);
        remove_database_files(&to);
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }

    #[test]
    fn copy_database_files_requires_source_database() {
        let from = temp_dir("storage-missing-from");
        let to = temp_dir("storage-missing-to");
        let error = copy_database_files(&from, &to).expect_err("缺少源库应失败");
        assert!(error.contains("不存在"), "错误：{error}");
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }

    #[test]
    fn storage_config_round_trips_and_resolves_relative_paths() {
        let dir = temp_dir("storage-config");
        let config_file = dir.join("storage.json");
        let custom = dir.join("custom-data");
        save_config_to(&config_file, Some(&custom)).expect("写入配置");
        let config = load_config_from(&config_file);
        assert_eq!(
            config.data_dir.as_deref(),
            Some(custom.to_string_lossy().as_ref())
        );
        assert_eq!(resolve_data_dir(&config, &dir), custom);

        // 相对路径按默认目录解析；缺失/空配置回落默认目录。
        let relative = StorageConfig {
            data_dir: Some("data".to_string()),
        };
        assert_eq!(resolve_data_dir(&relative, &dir), dir.join("data"));
        assert_eq!(resolve_data_dir(&StorageConfig::default(), &dir), dir);

        // 恢复默认会写入 null。
        save_config_to(&config_file, None).expect("清除配置");
        assert!(load_config_from(&config_file).data_dir.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_database_switches_connection_and_keeps_data() {
        use crate::models::NewBoardInput;
        use crate::repo;

        let from = temp_dir("storage-switch-from");
        let to = temp_dir("storage-switch-to");
        let connection = db::open(&db_path(&from)).expect("创建源数据库");
        let db = Db::new(connection);
        repo::create_board(
            &mut *db.lock().expect("锁数据库"),
            NewBoardInput {
                title: "迁移看板".to_string(),
                description: None,
                color: None,
            },
        )
        .expect("写入看板");

        migrate_database(&from, &to, &db).expect("迁移数据库");
        let snapshot = repo::get_snapshot(&*db.lock().expect("锁新数据库")).expect("快照");
        assert_eq!(snapshot.boards.len(), 1);
        assert_eq!(snapshot.boards[0].title, "迁移看板");
        assert!(db_path(&to).is_file());
        // 迁移核心不删除旧库，由外层在配置写成功后清理。
        assert!(db_path(&from).is_file());

        drop(db);
        remove_database_files(&from);
        remove_database_files(&to);
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }
}
