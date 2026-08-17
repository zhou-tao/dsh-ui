//! dsh-ui desktop shell: owns the harness web-profile process and points the
//! main window at its UI. MVP keeps the harness on its default port (3080);
//! parsing the printed URL line / bundling a sidecar binary are follow-ups.
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

/// Default harness web-profile port (dsh --profile web).
const DEFAULT_HARNESS_URL: &str = "http://127.0.0.1:3080";

pub struct HarnessState(pub Mutex<Option<Child>>);

#[derive(serde::Serialize, Clone)]
pub struct HarnessStatus {
    running: bool,
    url: Option<String>,
}

#[tauri::command]
pub fn harness_status(state: State<'_, HarnessState>) -> HarnessStatus {
    let running = state.0.lock().unwrap().is_some();
    HarnessStatus {
        running,
        url: running.then(|| DEFAULT_HARNESS_URL.to_string()),
    }
}

/// Spawn `dsh --profile web` (if not already running) and navigate the main
/// window to the harness UI.
#[tauri::command]
pub fn start_harness(state: State<'_, HarnessState>, app: tauri::AppHandle) -> Result<HarnessStatus, String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Ok(HarnessStatus {
            running: true,
            url: Some(DEFAULT_HARNESS_URL.to_string()),
        });
    }
    let child = Command::new("dsh")
        .args(["--profile", "web"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start dsh: {e}"))?;
    *guard = Some(child);
    let url = DEFAULT_HARNESS_URL.to_string();
    if let Some(win) = app.get_webview_window("main") {
        let target = url
            .parse::<tauri::Url>()
            .map_err(|e| format!("bad harness url {url}: {e}"))?;
        win.navigate(target).map_err(|e| format!("navigate failed: {e}"))?;
    }
    Ok(HarnessStatus {
        running: true,
        url: Some(url),
    })
}

#[tauri::command]
pub fn stop_harness(state: State<'_, HarnessState>) -> bool {
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        return true;
    }
    false
}

fn stop(state: &State<'_, HarnessState>) {
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(HarnessState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![harness_status, start_harness, stop_harness])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop(&app.state::<HarnessState>());
            }
        });
}
