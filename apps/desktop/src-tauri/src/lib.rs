//! dsh-ui desktop shell: owns the harness web-profile process and points the
//! main window at its UI.
//!
//! 行为：harness 已在监听默认端口时直接导航（不重复 spawn，避免 EADDRINUSE）；
//! 否则 spawn `dsh --profile web` 并轮询等待就绪。
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, State};

/// Default harness web-profile port (dsh --profile web).
const HARNESS_HOST: &str = "127.0.0.1";
const HARNESS_PORT: u16 = 3080;
const HARNESS_URL: &str = "http://127.0.0.1:3080";
const BOOT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct HarnessState(pub Mutex<Option<Child>>);

#[derive(serde::Serialize, Clone)]
pub struct HarnessStatus {
    running: bool,
    url: Option<String>,
}

/// TCP 探活：harness 是否已在监听默认端口。
fn harness_listening() -> bool {
    TcpStream::connect((HARNESS_HOST, HARNESS_PORT)).is_ok()
}

fn wait_for_harness(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if harness_listening() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    harness_listening()
}

fn navigate_to_harness(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };
    let target = HARNESS_URL
        .parse::<tauri::Url>()
        .map_err(|e| format!("bad harness url {HARNESS_URL}: {e}"))?;
    win.navigate(target).map_err(|e| format!("navigate failed: {e}"))
}

#[tauri::command]
fn harness_status(state: State<'_, HarnessState>) -> HarnessStatus {
    let running = state.0.lock().unwrap().is_some() || harness_listening();
    HarnessStatus {
        running,
        url: running.then(|| HARNESS_URL.to_string()),
    }
}

#[tauri::command]
fn start_harness(state: State<'_, HarnessState>, app: tauri::AppHandle) -> Result<HarnessStatus, String> {
    // 已有进程或端口已在监听：直接导航
    if state.0.lock().unwrap().is_some() || harness_listening() {
        navigate_to_harness(&app)?;
        return Ok(HarnessStatus {
            running: true,
            url: Some(HARNESS_URL.to_string()),
        });
    }
    // 否则 spawn dsh 并等待就绪
    let child = Command::new("dsh")
        .args(["--profile", "web"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start dsh: {e}"))?;
    *state.0.lock().unwrap() = Some(child);
    if !wait_for_harness(BOOT_TIMEOUT) {
        return Err(format!("harness 未在 {BOOT_TIMEOUT:?} 内就绪（{HARNESS_URL}）"));
    }
    navigate_to_harness(&app)?;
    Ok(HarnessStatus {
        running: true,
        url: Some(HARNESS_URL.to_string()),
    })
}

#[tauri::command]
fn stop_harness(state: State<'_, HarnessState>) -> bool {
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
