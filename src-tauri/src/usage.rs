//! 桌面软件使用统计（V0.10）。
//!
//! 后台线程每秒采样一次「前台窗口所属进程」，统计用户实际在用的软件：
//! - Windows API 全部用 raw FFI 手写声明（`user32` / `kernel32`），不引入任何新 crate；
//! - 只统计前台窗口所属进程，不累计后台进程；排除潮线自身进程；
//! - 暂停或用户空闲时停止记账并重置当前应用，恢复后重新起算（不补记暂停期间的时间）；
//! - 采样结果先进内存缓冲，每 10 秒落库到 `usage_daily`（按「应用 + 本地日期」累加）。
//!
//! 数据访问函数都接收 `&Connection`，不依赖 Tauri 运行时，因此可以用内存 SQLite 做单元测试；
//! 命令层只负责加锁并透传 `Result<_, String>`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::models::*;

/// 空闲阈值默认值（秒）：5 分钟没有输入即视为空闲。
pub const DEFAULT_IDLE_THRESHOLD_SECONDS: i64 = 300;
/// 空闲阈值允许的最小值（秒）。
pub const MIN_IDLE_THRESHOLD_SECONDS: i64 = 30;
/// 空闲阈值允许的最大值（秒）。
pub const MAX_IDLE_THRESHOLD_SECONDS: i64 = 3600;
/// 采样周期（秒）。
pub const SAMPLE_INTERVAL_SECONDS: u64 = 1;
/// 落库周期（秒）。
pub const FLUSH_INTERVAL_SECONDS: u64 = 10;
/// 单段结算时长上限（秒）：避免异常膨胀。
const SEGMENT_MAX_SECONDS: i64 = 60;
/// 采样间隔超过这个秒数就认为采样线程被挂起（系统休眠、休眠恢复、长时间抢不到 CPU）。
/// 这段时间用户并没有在用电脑，不能算到前台应用头上，否则一次休眠就会凭空多出几小时。
const MAX_SAMPLE_GAP_SECONDS: u64 = 60;
/// 单次查询允许展开的最大天数（约 10 年），避免异常区间把内存打满。
const MAX_RANGE_DAYS: usize = 3660;

// ---------------------------------------------------------------------------
// Windows raw FFI
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win {
    //! Windows API 的 raw FFI 声明（手写 extern "system"，不引入额外 crate）。

    /// PROCESS_QUERY_LIMITED_INFORMATION：查询进程路径所需的最小权限。
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    /// `LASTINPUTINFO`：记录最后一次输入的 tick 计数。
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct LASTINPUTINFO {
        pub cb_size: u32,
        pub dw_time: u32,
    }

    /// `SYSTEMTIME`：本地时间结构。
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct SYSTEMTIME {
        pub w_year: u16,
        pub w_month: u16,
        pub w_day_of_week: u16,
        pub w_day: u16,
        pub w_hour: u16,
        pub w_minute: u16,
        pub w_second: u16,
        pub w_milliseconds: u16,
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> isize;
        pub fn GetWindowThreadProcessId(hwnd: isize, process_id: *mut u32) -> u32;
        pub fn GetLastInputInfo(info: *mut LASTINPUTINFO) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> isize;
        pub fn QueryFullProcessImageNameW(
            handle: isize,
            flags: u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
        pub fn CloseHandle(handle: isize) -> i32;
        /// 32 位毫秒计数（会回绕，空闲判定必须用回绕减法）。
        pub fn GetTickCount() -> u32;
        /// 本地时间（`GetLocalTime` 由 kernel32 导出）。
        pub fn GetLocalTime(time: *mut SYSTEMTIME);
    }
}

// ---------------------------------------------------------------------------
// 前台窗口 / 空闲判定 / 本地日期
// ---------------------------------------------------------------------------

/// 前台窗口所属进程的可执行文件信息。
#[derive(Debug, Clone)]
pub struct ForegroundApp {
    /// 进程 id
    pub pid: u32,
    /// exe 完整路径
    pub exe_path: String,
    /// 统计用的应用标识（文件名去 `.exe` 后的小写形式）
    pub app_key: String,
    /// 展示名（去掉 `.exe` 的原始文件名）
    pub app_name: String,
}

/// 取当前前台窗口所属进程的 exe 完整路径；取不到时返回 `None`。
#[cfg(target_os = "windows")]
pub fn foreground_app() -> Option<ForegroundApp> {
    unsafe {
        let hwnd = win::GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }
        let mut pid: u32 = 0;
        win::GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let exe_path = process_image_path(pid)?;
        let app_key = app_key_from_path(&exe_path);
        if app_key.is_empty() {
            return None;
        }
        let app_name = app_name_from_path(&exe_path);
        Some(ForegroundApp {
            pid,
            exe_path,
            app_key,
            app_name,
        })
    }
}

/// 非 Windows 平台没有前台窗口 API，采样器直接不记账。
#[cfg(not(target_os = "windows"))]
pub fn foreground_app() -> Option<ForegroundApp> {
    None
}

/// 查询进程的可执行文件完整路径。
#[cfg(target_os = "windows")]
fn process_image_path(pid: u32) -> Option<String> {
    /// 进程路径缓冲区长度（字符数）：足够容纳长路径。
    const MAX_PATH_CHARS: usize = 2048;

    unsafe {
        let handle = win::OpenProcess(win::PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return None;
        }
        let mut buffer = [0u16; MAX_PATH_CHARS];
        let mut size = buffer.len() as u32;
        let ok = win::QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        win::CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let text = String::from_utf16_lossy(&buffer[..size as usize]);
        let text = text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// 用户空闲毫秒数（距最后一次键鼠输入）；取不到时返回 `None`。
#[cfg(target_os = "windows")]
pub fn idle_millis() -> Option<u64> {
    use std::mem::size_of;

    unsafe {
        let mut info = win::LASTINPUTINFO {
            cb_size: size_of::<win::LASTINPUTINFO>() as u32,
            dw_time: 0,
        };
        if win::GetLastInputInfo(&mut info) == 0 {
            return None;
        }
        // `dw_time` 是 32 位 `GetTickCount` 值：系统连续运行约 49.7 天后会回绕，
        // 必须用回绕减法，否则差值会变成一个巨大的数、把用户永久判成空闲。
        let now = win::GetTickCount();
        Some(now.wrapping_sub(info.dw_time) as u64)
    }
}

/// 非 Windows 平台没有输入空闲信息，按「不空闲」处理。
#[cfg(not(target_os = "windows"))]
pub fn idle_millis() -> Option<u64> {
    Some(0)
}

/// 本地日期 `YYYY-MM-DD`（跨天记账以本地日期为准）。
pub fn local_today() -> String {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let mut time = win::SYSTEMTIME {
                w_year: 0,
                w_month: 0,
                w_day_of_week: 0,
                w_day: 0,
                w_hour: 0,
                w_minute: 0,
                w_second: 0,
                w_milliseconds: 0,
            };
            win::GetLocalTime(&mut time);
            format!(
                "{:04}-{:02}-{:02}",
                time.w_year, time.w_month, time.w_day
            )
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 回退：按 epoch 手算 UTC 日期（不引入 chrono）。
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs() as i64)
            .unwrap_or_default();
        crate::repo::iso_from_unix(seconds, 0)[..10].to_string()
    }
}

// ---------------------------------------------------------------------------
// 应用标识归一化
// ---------------------------------------------------------------------------

/// 取路径中的文件名部分（兼容 `\` 与 `/` 分隔）。
fn file_name_of(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path).trim()
}

/// 去掉大小写不敏感的 `.exe` 后缀。
fn strip_exe_suffix(file: &str) -> &str {
    if file.len() >= 4 && file.to_ascii_lowercase().ends_with(".exe") {
        &file[..file.len() - 4]
    } else {
        file
    }
}

/// 由 exe 完整路径推导统计标识：文件名去 `.exe` 后转小写（如 `chrome.exe` → `chrome`）。
pub fn app_key_from_path(path: &str) -> String {
    strip_exe_suffix(file_name_of(path)).to_lowercase()
}

/// 由 exe 完整路径推导展示名：去掉 `.exe` 的原始文件名（保留原始大小写）。
pub fn app_name_from_path(path: &str) -> String {
    strip_exe_suffix(file_name_of(path)).to_string()
}

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------

/// 解析 `YYYY-MM-DD`；格式非法返回 `None`。
fn parse_day(text: &str) -> Option<(i64, u32, u32)> {
    let text = text.trim();
    let mut parts = text.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

/// 某年某月的天数。
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 日期 → `YYYY-MM-DD` 文本。
fn format_day(date: (i64, u32, u32)) -> String {
    format!("{:04}-{:02}-{:02}", date.0, date.1, date.2)
}

/// Howard Hinnant 的 `days_from_civil`：公历日期 → 1970-01-01 起的天数。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i64;
    let day = day as i64;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Howard Hinnant 的 `civil_from_days`：1970-01-01 起的天数 → 公历日期。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 闭区间 `[from, to]` 内的所有日期（升序）。
fn days_in_range(from: (i64, u32, u32), to: (i64, u32, u32)) -> Vec<String> {
    let start = days_from_civil(from.0, from.1, from.2);
    let end = days_from_civil(to.0, to.1, to.2);
    let mut days = Vec::new();
    let mut cursor = start;
    while cursor <= end && days.len() < MAX_RANGE_DAYS {
        let (year, month, day) = civil_from_days(cursor);
        days.push(format!("{year:04}-{month:02}-{day:02}"));
        cursor += 1;
    }
    days
}

// ---------------------------------------------------------------------------
// 数据访问
// ---------------------------------------------------------------------------

/// 累加某应用某天的使用秒数（同一天重复写入只会累加）。
pub fn add_daily_seconds(
    connection: &Connection,
    app_key: &str,
    day: &str,
    seconds: i64,
) -> Result<(), String> {
    if app_key.is_empty() || seconds <= 0 {
        return Ok(());
    }
    connection
        .execute(
            "INSERT INTO usage_daily (app_key, day, seconds) VALUES (?1, ?2, ?3) \
             ON CONFLICT(app_key, day) DO UPDATE SET seconds = seconds + excluded.seconds",
            params![app_key, day, seconds],
        )
        .map_err(|error| format!("写入使用记录失败：{error}"))?;
    Ok(())
}

/// 登记应用：首次发现写 `first_seen` / `last_seen`，之后只更新展示信息与 `last_seen`。
///
/// 用户是否勾选纳入统计（`included`）不会被覆盖。
pub fn touch_app(
    connection: &Connection,
    app_key: &str,
    app_name: &str,
    exe_path: &str,
) -> Result<(), String> {
    if app_key.is_empty() {
        return Ok(());
    }
    let stamp = crate::repo::now_iso();
    connection
        .execute(
            "INSERT INTO usage_apps (app_key, app_name, exe_path, included, first_seen, last_seen) \
             VALUES (?1, ?2, ?3, 1, ?4, ?4) \
             ON CONFLICT(app_key) DO UPDATE SET app_name = excluded.app_name, \
                 exe_path = excluded.exe_path, last_seen = excluded.last_seen",
            params![app_key, app_name, exe_path, &stamp],
        )
        .map_err(|error| format!("更新应用清单失败：{error}"))?;
    Ok(())
}

/// 记录一段使用时长：累加秒数并登记应用。
pub fn record_seconds(
    connection: &Connection,
    app_key: &str,
    app_name: &str,
    exe_path: &str,
    day: &str,
    seconds: i64,
) -> Result<(), String> {
    add_daily_seconds(connection, app_key, day, seconds)?;
    touch_app(connection, app_key, app_name, exe_path)
}

/// 应用清单（全量）：附带全时段累计使用秒数，按累计时长降序。
pub fn list_apps(connection: &Connection) -> Result<Vec<UsageApp>, String> {
    let mut statement = connection
        .prepare(
            "SELECT a.app_key, a.app_name, a.exe_path, a.included, a.first_seen, a.last_seen, \
                    COALESCE(SUM(d.seconds), 0) AS total_seconds \
             FROM usage_apps a \
             LEFT JOIN usage_daily d ON d.app_key = a.app_key \
             GROUP BY a.app_key \
             ORDER BY total_seconds DESC, a.app_name ASC",
        )
        .map_err(|error| format!("查询应用清单失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            let included: i64 = row.get("included")?;
            Ok(UsageApp {
                app_key: row.get("app_key")?,
                app_name: row.get("app_name")?,
                exe_path: row.get("exe_path")?,
                included: included != 0,
                total_seconds: row.get("total_seconds")?,
                first_seen: row.get("first_seen")?,
                last_seen: row.get("last_seen")?,
            })
        })
        .map_err(|error| format!("查询应用清单失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<UsageApp>>>()
        .map_err(|error| format!("查询应用清单失败：{error}"))
}

/// 查询单个应用（含全时段累计时长）。
fn find_app(connection: &Connection, app_key: &str) -> Result<Option<UsageApp>, String> {
    let mut statement = connection
        .prepare(
            "SELECT a.app_key, a.app_name, a.exe_path, a.included, a.first_seen, a.last_seen, \
                    COALESCE(SUM(d.seconds), 0) AS total_seconds \
             FROM usage_apps a \
             LEFT JOIN usage_daily d ON d.app_key = a.app_key \
             WHERE a.app_key = ?1 \
             GROUP BY a.app_key",
        )
        .map_err(|error| format!("查询应用失败：{error}"))?;
    let mut rows = statement
        .query_map(params![app_key], |row| {
            let included: i64 = row.get("included")?;
            Ok(UsageApp {
                app_key: row.get("app_key")?,
                app_name: row.get("app_name")?,
                exe_path: row.get("exe_path")?,
                included: included != 0,
                total_seconds: row.get("total_seconds")?,
                first_seen: row.get("first_seen")?,
                last_seen: row.get("last_seen")?,
            })
        })
        .map_err(|error| format!("查询应用失败：{error}"))?;
    let mut apps = rows
        .next()
        .transpose()
        .map_err(|error| format!("查询应用失败：{error}"))?;
    Ok(apps.take())
}

/// 切换某个应用是否纳入统计，返回更新后的应用。
pub fn set_app_included(
    connection: &Connection,
    input: &UsageAppIncludedInput,
) -> Result<UsageApp, String> {
    let app_key = input.app_key.trim();
    if app_key.is_empty() {
        return Err("应用标识不能为空".to_string());
    }
    let changed = connection
        .execute(
            "UPDATE usage_apps SET included = ?1 WHERE app_key = ?2",
            params![if input.included { 1 } else { 0 }, app_key],
        )
        .map_err(|error| format!("更新应用勾选状态失败：{error}"))?;
    if changed == 0 {
        return Err("应用不存在".to_string());
    }
    find_app(connection, app_key)?.ok_or_else(|| "应用不存在".to_string())
}

/// 读取使用统计设置。
pub fn get_settings(connection: &Connection) -> Result<UsageSettings, String> {
    let settings = connection
        .query_row(
            "SELECT paused, idle_threshold, updated_at FROM usage_settings WHERE id = 1",
            [],
            |row| {
                let paused: i64 = row.get(0)?;
                Ok(UsageSettings {
                    paused: paused != 0,
                    idle_threshold_seconds: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("读取使用统计设置失败：{error}"))?;
    Ok(settings.unwrap_or(UsageSettings {
        paused: false,
        idle_threshold_seconds: DEFAULT_IDLE_THRESHOLD_SECONDS,
        updated_at: crate::repo::now_iso(),
    }))
}

/// 更新使用统计设置：只更新传入的字段，空闲阈值越界时报错。
pub fn set_settings(
    connection: &Connection,
    input: &UsageSettingsInput,
) -> Result<UsageSettings, String> {
    let current = get_settings(connection)?;
    let paused = input.paused.unwrap_or(current.paused);
    let idle_threshold_seconds = input
        .idle_threshold_seconds
        .unwrap_or(current.idle_threshold_seconds);
    if !(MIN_IDLE_THRESHOLD_SECONDS..=MAX_IDLE_THRESHOLD_SECONDS).contains(&idle_threshold_seconds) {
        return Err(format!(
            "空闲阈值需在 {MIN_IDLE_THRESHOLD_SECONDS} 到 {MAX_IDLE_THRESHOLD_SECONDS} 秒之间"
        ));
    }
    let stamp = crate::repo::now_iso();
    connection
        .execute(
            "INSERT INTO usage_settings (id, paused, idle_threshold, updated_at) \
             VALUES (1, ?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, \
                 idle_threshold = excluded.idle_threshold, updated_at = excluded.updated_at",
            params![
                if paused { 1 } else { 0 },
                idle_threshold_seconds,
                &stamp
            ],
        )
        .map_err(|error| format!("保存使用统计设置失败：{error}"))?;
    Ok(UsageSettings {
        paused,
        idle_threshold_seconds,
        updated_at: stamp,
    })
}

/// 清空使用记录：只删 `usage_daily`，保留应用清单与设置。
pub fn clear_records(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM usage_daily", [])
        .map_err(|error| format!("清空使用记录失败：{error}"))?;
    Ok(())
}

/// 使用统计总览：区间闭区间 `[from, to]`，缺省按「今天」处理。
pub fn get_overview(
    connection: &Connection,
    input: &UsageRangeInput,
) -> Result<UsageOverview, String> {
    let today = local_today();
    let from_text = input
        .from
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(today.as_str());
    let to_text = input
        .to
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(today.as_str());
    let from = parse_day(from_text)
        .ok_or_else(|| "开始日期格式不正确，请使用 YYYY-MM-DD".to_string())?;
    let to = parse_day(to_text)
        .ok_or_else(|| "结束日期格式不正确，请使用 YYYY-MM-DD".to_string())?;
    // 允许前端把起止日期传反：自动纠正为升序区间。
    let (from, to) = if days_from_civil(from.0, from.1, from.2) <= days_from_civil(to.0, to.1, to.2)
    {
        (from, to)
    } else {
        (to, from)
    };
    let range_from = format_day(from);
    let range_to = format_day(to);

    // 各应用统计：只统计已勾选的应用，按秒数降序。
    let mut statement = connection
        .prepare(
            "SELECT d.app_key, a.app_name, SUM(d.seconds) AS seconds \
             FROM usage_daily d \
             JOIN usage_apps a ON a.app_key = d.app_key \
             WHERE d.day BETWEEN ?1 AND ?2 AND a.included = 1 \
             GROUP BY d.app_key \
             HAVING SUM(d.seconds) > 0 \
             ORDER BY seconds DESC, a.app_name ASC",
        )
        .map_err(|error| format!("查询使用统计失败：{error}"))?;
    let mut apps: Vec<UsageAppStat> = statement
        .query_map(params![range_from.as_str(), range_to.as_str()], |row| {
            Ok(UsageAppStat {
                app_key: row.get("app_key")?,
                app_name: row.get("app_name")?,
                seconds: row.get("seconds")?,
                share: 0.0,
            })
        })
        .map_err(|error| format!("查询使用统计失败：{error}"))?
        .collect::<rusqlite::Result<Vec<UsageAppStat>>>()
        .map_err(|error| format!("查询使用统计失败：{error}"))?;
    drop(statement);

    let total_seconds: i64 = apps.iter().map(|app| app.seconds).sum();
    let tracked_apps = apps.iter().filter(|app| app.seconds > 0).count() as i64;
    for app in apps.iter_mut() {
        app.share = if total_seconds > 0 {
            app.seconds as f64 / total_seconds as f64
        } else {
            0.0
        };
    }

    // 逐日统计：区间内每一天都要出现，缺失填 0。
    let mut statement = connection
        .prepare(
            "SELECT d.day, SUM(d.seconds) AS seconds \
             FROM usage_daily d \
             JOIN usage_apps a ON a.app_key = d.app_key \
             WHERE d.day BETWEEN ?1 AND ?2 AND a.included = 1 \
             GROUP BY d.day",
        )
        .map_err(|error| format!("查询每日使用统计失败：{error}"))?;
    let day_totals: HashMap<String, i64> = statement
        .query_map(params![range_from.as_str(), range_to.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("查询每日使用统计失败：{error}"))?
        .collect::<rusqlite::Result<HashMap<String, i64>>>()
        .map_err(|error| format!("查询每日使用统计失败：{error}"))?;
    drop(statement);

    let daily = days_in_range(from, to)
        .into_iter()
        .map(|day| UsageDailyStat {
            seconds: day_totals.get(&day).copied().unwrap_or(0),
            day,
        })
        .collect();

    Ok(UsageOverview {
        range_from,
        range_to,
        total_seconds,
        tracked_apps,
        apps,
        daily,
    })
}

// ---------------------------------------------------------------------------
// 采样器运行时
// ---------------------------------------------------------------------------

/// 采样器运行时状态：Tauri 状态 + 原子变量。
///
/// 设置命令写完数据库后立刻在这里生效，采样线程下一轮即可读到新值，
/// 不需要重启线程；数据库仍然是持久化真相。
pub struct UsageRuntime {
    paused: AtomicBool,
    idle_threshold: AtomicU64,
}

impl UsageRuntime {
    /// 用数据库里的设置初始化运行时状态。
    pub fn new(paused: bool, idle_threshold_seconds: i64) -> Self {
        Self {
            paused: AtomicBool::new(paused),
            idle_threshold: AtomicU64::new(idle_threshold_seconds.max(0) as u64),
        }
    }

    /// 是否暂停统计。
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    /// 设置暂停开关（立即生效）。
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    /// 当前空闲阈值（秒）。
    pub fn idle_threshold_seconds(&self) -> u64 {
        self.idle_threshold.load(Ordering::Relaxed)
    }

    /// 更新空闲阈值（秒，立即生效）。
    pub fn set_idle_threshold_seconds(&self, seconds: i64) {
        self.idle_threshold
            .store(seconds.max(0) as u64, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// 后台采样线程
// ---------------------------------------------------------------------------

/// 当前正在计时的应用段。
struct CurrentSegment {
    app_key: String,
    /// 本段起点（上次切换时刻）
    since: Instant,
    /// 上次累计的时刻
    last_accounted: Instant,
    /// 本段已累计的秒数
    credited: i64,
}

impl CurrentSegment {
    fn new(info: &ForegroundApp, now: Instant) -> Self {
        Self {
            app_key: info.app_key.clone(),
            since: now,
            last_accounted: now,
            credited: 0,
        }
    }
}

/// 采样被挂起（间隔远大于采样周期）时重置当前段。
///
/// 丢掉这一段尚未累计的时长并从当前时刻重新起算：
/// 系统休眠、休眠恢复或长时间抢不到 CPU 时，用户并没有在用电脑，
/// 这段时间不能算到前台应用头上。返回 `true` 表示发生了重置。
fn reset_if_stalled(segment: &mut CurrentSegment, now: Instant) -> bool {
    if now.duration_since(segment.last_accounted).as_secs() > MAX_SAMPLE_GAP_SECONDS {
        segment.since = now;
        segment.last_accounted = now;
        segment.credited = 0;
        return true;
    }
    false
}

/// 结算当前应用段：把这一段「尚未累计」的零头补记给旧应用。
///
/// 结算量 = `clamp(本段总时长, 1, 60) - 本段已累计秒数`（下限 0）：
/// - 快速切换（不足 1 秒）也至少记 1 秒，不漏掉闪切；
/// - 单段上限 60 秒，避免异常膨胀。
fn settle(
    segment: &CurrentSegment,
    now: Instant,
    buffer: &mut HashMap<(String, String), i64>,
    day: &str,
) {
    let elapsed = now.duration_since(segment.since).as_secs() as i64;
    let target = elapsed.clamp(1, SEGMENT_MAX_SECONDS);
    let extra = (target - segment.credited).max(0);
    if extra > 0 {
        *buffer
            .entry((segment.app_key.clone(), day.to_string()))
            .or_insert(0) += extra;
    }
}

/// 启动后台采样线程；线程随进程退出而结束。
pub fn spawn_sampler(app: AppHandle) {
    std::thread::spawn(move || sampler_loop(app));
}

/// 采样线程主循环：每秒采样一次，每 10 秒把缓冲写入数据库。
fn sampler_loop(app: AppHandle) {
    let own_pid = std::process::id();
    let mut current: Option<CurrentSegment> = None;
    // 待落库缓冲：(应用标识, 本地日期) → 秒数
    let mut buffer: HashMap<(String, String), i64> = HashMap::new();
    // 已发现应用：应用标识 → (展示名, exe 路径)
    let mut apps: HashMap<String, (String, String)> = HashMap::new();
    let mut last_flush = Instant::now();

    loop {
        std::thread::sleep(Duration::from_secs(SAMPLE_INTERVAL_SECONDS));
        let now = Instant::now();
        let day = local_today();

        let runtime = app.state::<UsageRuntime>();
        let paused = runtime.is_paused();
        let threshold = runtime.idle_threshold_seconds();
        let idle = idle_millis().unwrap_or(0);
        let is_idle = threshold > 0 && idle >= threshold.saturating_mul(1_000);
        // 排除潮线自身进程：前台是潮线时不记账，但上一段仍需结算。
        let foreground = foreground_app().filter(|info| info.pid != own_pid);

        if paused || is_idle {
            // 暂停 / 空闲：停止记账并重置当前应用状态，恢复后重新起算。
            current = None;
        } else {
            match current.take() {
                None => {
                    if let Some(info) = foreground {
                        apps.insert(
                            info.app_key.clone(),
                            (info.app_name.clone(), info.exe_path.clone()),
                        );
                        current = Some(CurrentSegment::new(&info, now));
                    }
                }
                Some(mut segment) => {
                    // 采样被挂起（系统休眠后恢复、长时间抢不到 CPU）时，这一轮间隔会远大于
                    // 采样周期；这段时间用户并没有在用电脑，必须丢弃并重新起算，
                    // 否则一次休眠就会给前台应用凭空加上几小时。
                    reset_if_stalled(&mut segment, now);
                    match foreground {
                        Some(info) if info.app_key == segment.app_key => {
                            // 同一个应用：按整秒累计。
                            let delta = now.duration_since(segment.last_accounted);
                            if delta >= Duration::from_secs(1) {
                                let seconds = delta.as_secs() as i64;
                                *buffer
                                    .entry((segment.app_key.clone(), day.clone()))
                                    .or_insert(0) += seconds;
                                segment.credited += seconds;
                                segment.last_accounted += Duration::from_secs(seconds as u64);
                            }
                            current = Some(segment);
                        }
                        Some(info) => {
                            // 切换应用：把上一段时长结算给旧应用。
                            settle(&segment, now, &mut buffer, &day);
                            apps.insert(
                                info.app_key.clone(),
                                (info.app_name.clone(), info.exe_path.clone()),
                            );
                            current = Some(CurrentSegment::new(&info, now));
                        }
                        None => {
                            // 没有前台窗口：结算上一段后停止记录。
                            settle(&segment, now, &mut buffer, &day);
                            current = None;
                        }
                    }
                }
            }
        }

        if last_flush.elapsed() >= Duration::from_secs(FLUSH_INTERVAL_SECONDS) {
            flush(&app, &mut buffer, &apps);
            last_flush = Instant::now();
        }
    }
}

/// 把缓冲写入数据库：累加 `usage_daily`，并登记应用清单。
fn flush(
    app: &AppHandle,
    buffer: &mut HashMap<(String, String), i64>,
    apps: &HashMap<String, (String, String)>,
) {
    if buffer.is_empty() && apps.is_empty() {
        return;
    }
    let db = app.state::<Db>();
    let Ok(connection) = db.lock() else {
        // 正在切换数据目录：本轮先不写，下一轮补上。
        return;
    };
    // 先登记应用清单：新发现的应用即使还没累计满 1 秒也要出现在清单里。
    for (app_key, (app_name, exe_path)) in apps.iter() {
        if let Err(error) = touch_app(&connection, app_key, app_name, exe_path) {
            eprintln!("[tideline] 更新应用清单失败：{error}");
        }
    }
    // 再落库使用时长（`record_seconds` 内部会同时刷新应用清单的 last_seen）。
    let mut failed: Vec<((String, String), i64)> = Vec::new();
    for ((app_key, day), seconds) in buffer.iter() {
        let (app_name, exe_path) = apps
            .get(app_key)
            .cloned()
            .unwrap_or_else(|| (app_key.clone(), String::new()));
        if let Err(error) = record_seconds(&connection, app_key, &app_name, &exe_path, day, *seconds) {
            eprintln!("[tideline] 写入使用记录失败：{error}");
            failed.push(((app_key.clone(), day.clone()), *seconds));
        }
    }
    buffer.clear();
    for (key, seconds) in failed {
        buffer.insert(key, seconds);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    /// 建一个带默认设置的内存库。
    fn test_db() -> Connection {
        open_in_memory().expect("内存数据库应可初始化")
    }

    /// 写入一段使用记录。
    fn seed(connection: &Connection, key: &str, name: &str, day: &str, seconds: i64) {
        record_seconds(
            connection,
            key,
            name,
            &format!("C:\\Apps\\{name}.exe"),
            day,
            seconds,
        )
        .expect("写入使用记录");
    }

    /// 指定区间的查询入参。
    fn range(from: &str, to: &str) -> UsageRangeInput {
        UsageRangeInput {
            from: Some(from.to_string()),
            to: Some(to.to_string()),
        }
    }

    #[test]
    fn app_key_and_name_are_normalized() {
        assert_eq!(
            app_key_from_path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            "chrome"
        );
        assert_eq!(
            app_name_from_path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            "chrome"
        );
        // 大小写不敏感地去掉 .exe；展示名保留原始大小写。
        assert_eq!(app_key_from_path(r"C:\Windows\NOTEPAD.EXE"), "notepad");
        assert_eq!(app_name_from_path(r"C:\Windows\NOTEPAD.EXE"), "NOTEPAD");
        // 没有 .exe 后缀时原样使用。
        assert_eq!(app_key_from_path("/usr/bin/Code"), "code");
        assert_eq!(app_name_from_path("/usr/bin/Code"), "Code");
        // 目录分隔符兼容正斜杠。
        assert_eq!(app_key_from_path("/opt/tools/Foo.Bar.exe"), "foo.bar");
        assert_eq!(app_name_from_path("/opt/tools/Foo.Bar.exe"), "Foo.Bar");
        // 空路径没有有效标识。
        assert_eq!(app_key_from_path(""), "");
        assert_eq!(app_name_from_path(""), "");
    }

    #[test]
    fn daily_seconds_accumulate_for_same_app_and_day() {
        let connection = test_db();
        seed(&connection, "chrome", "chrome", "2026-10-01", 30);
        seed(&connection, "chrome", "chrome", "2026-10-01", 45);
        let seconds: i64 = connection
            .query_row(
                "SELECT seconds FROM usage_daily WHERE app_key = 'chrome' AND day = '2026-10-01'",
                [],
                |row| row.get(0),
            )
            .expect("读取当日累计秒数");
        assert_eq!(seconds, 75);
    }

    #[test]
    fn overview_filters_by_range_and_fills_missing_days() {
        let connection = test_db();
        seed(&connection, "chrome", "chrome", "2026-10-01", 60);
        seed(&connection, "chrome", "chrome", "2026-10-03", 30);

        let overview = get_overview(&connection, &range("2026-10-01", "2026-10-02"))
            .expect("查询使用统计总览");
        assert_eq!(overview.range_from, "2026-10-01");
        assert_eq!(overview.range_to, "2026-10-02");
        assert_eq!(overview.total_seconds, 60);
        assert_eq!(overview.tracked_apps, 1);
        assert_eq!(overview.apps.len(), 1);
        assert_eq!(overview.apps[0].app_key, "chrome");
        assert!((overview.apps[0].share - 1.0).abs() < 1e-9);
        // 区间内每一天都要出现，缺失的补 0。
        assert_eq!(overview.daily.len(), 2);
        assert_eq!(overview.daily[0].day, "2026-10-01");
        assert_eq!(overview.daily[0].seconds, 60);
        assert_eq!(overview.daily[1].day, "2026-10-02");
        assert_eq!(overview.daily[1].seconds, 0);
    }

    #[test]
    fn excluded_apps_are_not_counted_in_overview() {
        let connection = test_db();
        seed(&connection, "chrome", "chrome", "2026-10-01", 60);
        seed(&connection, "code", "code", "2026-10-01", 40);
        set_app_included(
            &connection,
            &UsageAppIncludedInput {
                app_key: "code".to_string(),
                included: false,
            },
        )
        .expect("取消勾选应用");

        let overview = get_overview(&connection, &range("2026-10-01", "2026-10-01"))
            .expect("查询使用统计总览");
        assert_eq!(overview.total_seconds, 60);
        assert_eq!(overview.tracked_apps, 1);
        assert_eq!(overview.apps.len(), 1);
        assert_eq!(overview.apps[0].app_key, "chrome");

        // 应用清单仍然保留未勾选的应用，且累计时长不受勾选影响。
        let apps = list_apps(&connection).expect("查询应用清单");
        assert_eq!(apps.len(), 2);
        let code = apps
            .iter()
            .find(|app| app.app_key == "code")
            .expect("code 应在清单中");
        assert!(!code.included);
        assert_eq!(code.total_seconds, 40);
    }

    #[test]
    fn app_list_is_sorted_by_total_seconds() {
        let connection = test_db();
        seed(&connection, "code", "code", "2026-10-01", 10);
        seed(&connection, "chrome", "chrome", "2026-10-01", 90);
        let apps = list_apps(&connection).expect("查询应用清单");
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].app_key, "chrome");
        assert_eq!(apps[0].total_seconds, 90);
        assert_eq!(apps[1].app_key, "code");
        assert_eq!(apps[1].total_seconds, 10);
        assert!(apps[0].included);
    }

    #[test]
    fn clear_records_keeps_app_list_and_settings() {
        let connection = test_db();
        seed(&connection, "chrome", "chrome", "2026-10-01", 60);
        set_settings(
            &connection,
            &UsageSettingsInput {
                paused: Some(true),
                idle_threshold_seconds: None,
            },
        )
        .expect("更新设置");

        clear_records(&connection).expect("清空使用记录");

        let daily_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM usage_daily", [], |row| row.get(0))
            .expect("统计使用记录");
        assert_eq!(daily_count, 0);
        // 应用清单保留。
        let apps = list_apps(&connection).expect("查询应用清单");
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].app_key, "chrome");
        // 设置保留。
        let settings = get_settings(&connection).expect("读取设置");
        assert!(settings.paused);
    }

    #[test]
    fn settings_only_update_provided_fields() {
        let connection = test_db();
        let settings = get_settings(&connection).expect("读取设置");
        assert!(!settings.paused);
        assert_eq!(
            settings.idle_threshold_seconds,
            DEFAULT_IDLE_THRESHOLD_SECONDS
        );

        set_settings(
            &connection,
            &UsageSettingsInput {
                paused: Some(true),
                idle_threshold_seconds: None,
            },
        )
        .expect("更新暂停开关");
        let settings = get_settings(&connection).expect("读取设置");
        assert!(settings.paused);
        assert_eq!(
            settings.idle_threshold_seconds,
            DEFAULT_IDLE_THRESHOLD_SECONDS
        );

        set_settings(
            &connection,
            &UsageSettingsInput {
                paused: None,
                idle_threshold_seconds: Some(600),
            },
        )
        .expect("更新空闲阈值");
        let settings = get_settings(&connection).expect("读取设置");
        assert!(settings.paused);
        assert_eq!(settings.idle_threshold_seconds, 600);
    }

    #[test]
    fn settings_reject_out_of_range_idle_threshold() {
        let connection = test_db();
        let error = set_settings(
            &connection,
            &UsageSettingsInput {
                paused: None,
                idle_threshold_seconds: Some(10),
            },
        )
        .expect_err("越界的空闲阈值应报错");
        assert_eq!(error, "空闲阈值需在 30 到 3600 秒之间");

        let error = set_settings(
            &connection,
            &UsageSettingsInput {
                paused: None,
                idle_threshold_seconds: Some(3601),
            },
        )
        .expect_err("越界的空闲阈值应报错");
        assert_eq!(error, "空闲阈值需在 30 到 3600 秒之间");
    }

    #[test]
    fn overview_defaults_to_today_and_rejects_bad_dates() {
        let connection = test_db();
        let overview = get_overview(&connection, &UsageRangeInput::default())
            .expect("缺省区间按今天处理");
        assert_eq!(overview.range_from, local_today());
        assert_eq!(overview.range_to, local_today());
        assert_eq!(overview.total_seconds, 0);
        assert_eq!(overview.apps.len(), 0);
        assert_eq!(overview.daily.len(), 1);

        let error = get_overview(&connection, &range("2026-13-01", "2026-10-01"))
            .expect_err("非法日期应报错");
        assert!(error.contains("日期格式不正确"), "错误：{error}");
    }

    #[test]
    fn runtime_shares_settings_with_sampler() {
        let runtime = UsageRuntime::new(false, DEFAULT_IDLE_THRESHOLD_SECONDS);
        assert!(!runtime.is_paused());
        assert_eq!(
            runtime.idle_threshold_seconds(),
            DEFAULT_IDLE_THRESHOLD_SECONDS as u64
        );
        runtime.set_paused(true);
        runtime.set_idle_threshold_seconds(600);
        assert!(runtime.is_paused());
        assert_eq!(runtime.idle_threshold_seconds(), 600);
    }

    #[test]
    fn day_range_helpers_cover_every_day() {
        let days = days_in_range((2026, 10, 1), (2026, 10, 3));
        assert_eq!(
            days,
            vec![
                "2026-10-01".to_string(),
                "2026-10-02".to_string(),
                "2026-10-03".to_string()
            ]
        );
        // 跨月、跨闰年。
        let days = days_in_range((2024, 2, 28), (2024, 3, 1));
        assert_eq!(
            days,
            vec![
                "2024-02-28".to_string(),
                "2024-02-29".to_string(),
                "2024-03-01".to_string()
            ]
        );
    }

    #[test]
    fn stalled_sampling_discards_gap_instead_of_counting_it() {
        let info = ForegroundApp {
            pid: 4242,
            exe_path: r"C:\Windows\notepad.exe".to_string(),
            app_key: "notepad".to_string(),
            app_name: "notepad".to_string(),
        };
        let start = Instant::now();
        let mut segment = CurrentSegment::new(&info, start);
        segment.credited = 10;
        segment.last_accounted = start + Duration::from_secs(10);

        // 正常采样间隔（1 秒）不触发重置。
        assert!(!reset_if_stalled(&mut segment, start + Duration::from_secs(11)));
        assert_eq!(segment.credited, 10);

        // 系统休眠 30 分钟后恢复：待累计时长必须丢弃，不能记到应用头上。
        let resumed = start + Duration::from_secs(1810);
        assert!(reset_if_stalled(&mut segment, resumed));
        assert_eq!(segment.credited, 0);
        assert_eq!(segment.last_accounted, resumed);

        // 重置后结算：零头只按 1 秒计，而不是整段休眠时长。
        let mut buffer: HashMap<(String, String), i64> = HashMap::new();
        settle(&segment, resumed, &mut buffer, "2026-10-31");
        assert_eq!(
            buffer
                .get(&("notepad".to_string(), "2026-10-31".to_string()))
                .copied(),
            Some(1)
        );
    }
}
