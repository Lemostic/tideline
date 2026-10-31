//! 开机自动启动（V0.7.3）：写入当前用户 HKCU Run 键。
//!
//! 使用注册表而不是启动文件夹，便于设置页即时查询/开关；不请求管理员权限。
//! 卸载器会清理名为 `tideline` 的 Run 值（与安装器模板保持一致）。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStartInfo {
    pub supported: bool,
    pub enabled: bool,
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "tideline";

#[cfg(target_os = "windows")]
fn open_run_key(write: bool) -> Result<winreg::RegKey, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let access = if write { KEY_READ | KEY_SET_VALUE } else { KEY_READ };
    hkcu.open_subkey_with_flags(RUN_KEY, access)
        .map_err(|error| format!("打开开机启动注册表失败：{error}"))
}

#[cfg(target_os = "windows")]
fn query_value(value_name: &str) -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取开机启动设置失败：{error}")),
    };
    match key.get_value::<String, _>(value_name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("读取开机启动设置失败：{error}")),
    }
}

fn autostart_command(exe: &std::path::Path) -> String {
    format!("\"{}\"", exe.display())
}

#[cfg(target_os = "windows")]
fn write_value(value_name: &str, enabled: bool) -> Result<(), String> {
    let key = open_run_key(true)?;
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|error| format!("无法获取应用路径：{error}"))?;
        let command = autostart_command(&exe);
        key.set_value(value_name, &command)
            .map_err(|error| format!("写入开机启动设置失败：{error}"))?;
    } else {
        match key.delete_value(value_name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("关闭开机启动失败：{error}")),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn get_autostart() -> Result<AutoStartInfo, String> {
    Ok(AutoStartInfo {
        supported: true,
        enabled: query_value(VALUE_NAME)?,
    })
}

#[cfg(target_os = "windows")]
pub fn set_autostart(enabled: bool) -> Result<AutoStartInfo, String> {
    write_value(VALUE_NAME, enabled)?;
    get_autostart()
}

#[cfg(not(target_os = "windows"))]
pub fn get_autostart() -> Result<AutoStartInfo, String> {
    Ok(AutoStartInfo {
        supported: false,
        enabled: false,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn set_autostart(_enabled: bool) -> Result<AutoStartInfo, String> {
    Err("当前平台不支持开机自动启动，请使用 Windows 安装版".to_string())
}

#[cfg(test)]
mod tests {
    use super::autostart_command;
    use std::path::Path;

    #[test]
    fn autostart_command_quotes_executable_path() {
        let command = autostart_command(Path::new(r"C:\Program Files\Tideline\tideline.exe"));
        assert_eq!(command, "\"C:\\Program Files\\Tideline\\tideline.exe\"");
        assert!(command.starts_with('"') && command.ends_with('"'));
    }
}
