use std::process::Command as StdCommand;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Spawn the Python backend on a random port to avoid conflicts
      let resource_dir = app
        .path()
        .resource_dir()
        .expect("resource dir");
      let data_dir = app
        .path()
        .app_local_data_dir()
        .expect("app local data dir");
      std::fs::create_dir_all(&data_dir).ok();

      let db_path = data_dir.join("great_minds.db");
      let database_url = format!("sqlite+aiosqlite:///{}", db_path.display());

      log::info!("Starting backend with DB: {}", database_url);

      let mut cmd = StdCommand::new("uv");
      cmd.args(["run", "great-minds", "serve", "--host", "127.0.0.1", "--port", "8417"])
        .env("DATABASE_URL", &database_url)
        .env("DATA_DIR", data_dir.to_str().unwrap())
        .env("CORS_ORIGINS", r#"["tauri://localhost", "http://localhost:5173"]"#)
        .env("SUPPRESS_AUTH", "true")
        .current_dir(
          resource_dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
        );

      std::thread::spawn(move || {
        match cmd.spawn() {
          Ok(mut child) => {
            log::info!("Backend PID: {}", child.id());
            let _ = child.wait();
            log::warn!("Backend exited");
          }
          Err(e) => {
            log::error!("Failed to start backend: {}", e);
          }
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
