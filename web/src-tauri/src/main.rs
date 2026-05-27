#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

const KEYCHAIN_SERVICE: &str = "dev.greatmind.desktop";
const REFRESH_TOKEN_USER: &str = "refresh_token";

fn refresh_token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, REFRESH_TOKEN_USER)
        .map_err(|err| format!("failed to open credential store: {err}"))
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            store_refresh_token,
            get_refresh_token,
            delete_refresh_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Great Minds desktop shell");
}
