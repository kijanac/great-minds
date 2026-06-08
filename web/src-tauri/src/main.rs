#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

const KEYCHAIN_SERVICE: &str = "dev.greatmind.desktop";
const REFRESH_TOKEN_USER: &str = "refresh_token";
const HOST: &str = "127.0.0.1";

#[derive(Default)]
struct BackendState {
    api_base: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
}

impl Drop for BackendState {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestFile {
    name: String,
    path: String,
    bytes: Vec<u8>,
}

fn refresh_token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, REFRESH_TOKEN_USER)
        .map_err(|err| format!("failed to open credential store: {err}"))
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind((HOST, 0))
        .map_err(|err| format!("failed to reserve local backend port: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("failed to read local backend port: {err}"))
}

fn default_backend_cwd() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn shell_command(command: &str, cwd: &Path) -> Command {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", command]);
        cmd
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = Command::new("sh");
        cmd.arg("-lc").arg(command);
        cmd
    };

    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    cmd
}

fn wait_for_port(port: u16) -> bool {
    for _ in 0..50 {
        if TcpStream::connect((HOST, port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn set_api_base(state: &BackendState, api_base: String) -> Result<(), String> {
    *state
        .api_base
        .lock()
        .map_err(|_| "backend api_base lock poisoned".to_string())? = Some(api_base);
    Ok(())
}

fn start_backend_if_requested(state: &BackendState) -> Result<(), String> {
    if let Ok(api_base) = env::var("GREAT_MINDS_DESKTOP_API_BASE") {
        return set_api_base(state, api_base);
    }

    let explicit_command = env::var("GREAT_MINDS_DESKTOP_BACKEND_CMD").ok();
    let start_default = env::var("GREAT_MINDS_DESKTOP_START_BACKEND")
        .ok()
        .as_deref()
        == Some("1");
    if explicit_command.is_none() && !start_default {
        return Ok(());
    }

    let port = free_port()?;
    let raw_command = explicit_command
        .unwrap_or_else(|| "uv run great-minds serve --host 127.0.0.1 --port {port}".to_string());
    let command = raw_command.replace("{port}", &port.to_string());
    let cwd = env::var("GREAT_MINDS_DESKTOP_BACKEND_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_backend_cwd());

    let mut child = shell_command(&command, &cwd)
        .spawn()
        .map_err(|err| format!("failed to start FastAPI sidecar: {err}"))?;

    if !wait_for_port(port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "FastAPI sidecar did not begin listening on {HOST}:{port}"
        ));
    }

    let api_base = format!("http://{HOST}:{port}/v1");
    set_api_base(state, api_base)?;
    *state
        .child
        .lock()
        .map_err(|_| "backend child lock poisoned".to_string())? = Some(child);
    Ok(())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<IngestFile>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| format!("failed to read directory: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|err| format!("failed to read metadata for {}: {err}", path.display()))?;

        if metadata.is_dir() {
            collect_files(root, &path, out)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        let bytes =
            fs::read(&path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file")
            .to_string();
        out.push(IngestFile {
            name,
            path: relative,
            bytes,
        });
    }
    Ok(())
}

#[tauri::command]
fn desktop_api_base(state: State<'_, BackendState>) -> Result<Option<String>, String> {
    state
        .api_base
        .lock()
        .map(|api_base| api_base.clone())
        .map_err(|_| "backend api_base lock poisoned".to_string())
}

#[tauri::command]
fn store_refresh_token(refresh_token: String) -> Result<(), String> {
    refresh_token_entry()?
        .set_password(&refresh_token)
        .map_err(|err| format!("failed to store refresh token: {err}"))
}

#[tauri::command]
fn get_refresh_token() -> Result<Option<String>, String> {
    match refresh_token_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("failed to read refresh token: {err}")),
    }
}

#[tauri::command]
fn delete_refresh_token() -> Result<(), String> {
    match refresh_token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("failed to delete refresh token: {err}")),
    }
}

#[tauri::command]
async fn browse_ingest_folder(app: tauri::AppHandle) -> Result<Option<Vec<IngestFile>>, String> {
    let Some(folder) = app
        .dialog()
        .file()
        .set_title("Choose a folder to ingest")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };

    let root = folder
        .into_path()
        .map_err(|err| format!("failed to resolve selected folder: {err}"))?;
    let root = root
        .canonicalize()
        .map_err(|err| format!("failed to resolve selected folder: {err}"))?;
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files)?;
    Ok(Some(files))
}

fn main() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(err) = start_backend_if_requested(&app.state::<BackendState>()) {
                eprintln!("FastAPI sidecar disabled: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_api_base,
            store_refresh_token,
            get_refresh_token,
            delete_refresh_token,
            browse_ingest_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Great Minds desktop shell");
}
