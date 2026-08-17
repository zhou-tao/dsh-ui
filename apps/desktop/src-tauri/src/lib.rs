//! dsh-ui desktop shell: owns the harness web-profile process and points the
//! main window at its UI; provides the phone-companion QR entry (mobile-h5 bridge).
use std::net::{TcpStream, UdpSocket};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

const HARNESS_HOST: &str = "127.0.0.1";
const HARNESS_PORT: u16 = 3080;
const HARNESS_URL: &str = "http://127.0.0.1:3080";
const BOOT_TIMEOUT: Duration = Duration::from_secs(10);
const BRIDGE_PORT: u16 = 4173;

/// Finder/Dock 启动的 GUI app 其 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
/// `Command::new("node")` 会直接 ENOENT —— 必须用绝对路径解析 node。
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("DSH_UI_NODE") {
        if !p.trim().is_empty() && std::path::Path::new(p.trim()).exists() {
            return p.trim().to_string();
        }
    }
    for cand in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
        if std::path::Path::new(cand).exists() {
            return cand.to_string();
        }
    }
    "node".to_string() // 开发环境 PATH 兜底
}

/// 子进程 PATH：保证 node / cloudflared / npx 等外部命令可解析（覆盖 Finder 启动的极简 PATH）。
const CHILD_PATH: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

fn on_path(name: &str) -> bool {
    Command::new("/usr/bin/which")
        .arg(name)
        .env("PATH", CHILD_PATH)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 解析 dsh 启动方式：PATH 上的 dsh → npx @deepseek-ai/dsh（本机经 npx 缓存运行）→ 常见绝对路径。
fn resolve_dsh() -> String {
    if let Ok(p) = std::env::var("DSH_UI_DSH") {
        if !p.trim().is_empty() {
            return p.trim().to_string();
        }
    }
    if on_path("dsh") {
        return "dsh".to_string();
    }
    if on_path("npx") {
        return "npx".to_string();
    }
    for cand in ["/usr/local/bin/dsh", "/opt/homebrew/bin/dsh"] {
        if std::path::Path::new(cand).exists() {
            return cand.to_string();
        }
    }
    "dsh".to_string()
}

/// 注入到 harness 页面的手机互联脚本（resources/inject.js）：
/// 1) 悬浮图标（FAB）：位于侧边栏设置按钮左侧 100px、无圆形蓝底、右上角小圆点默认隐藏、手机已连接时绿色；
/// 2) 手机互联 UI 层弹窗（替代原系统级独立窗口）：扫码连接（局域网 / 公网隧道）。
const INJECT_JS: &str = include_str!("../resources/inject.js");

pub struct HarnessState(pub Mutex<Option<Child>>);
pub struct BridgeState(pub Mutex<Option<Child>>);

#[derive(serde::Serialize, Clone)]
pub struct HarnessStatus {
    running: bool,
    url: Option<String>,
}

fn harness_listening() -> bool {
    TcpStream::connect((HARNESS_HOST, HARNESS_PORT)).is_ok()
}

fn bridge_listening() -> bool {
    TcpStream::connect(("127.0.0.1", BRIDGE_PORT)).is_ok()
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
    win.navigate(target).map_err(|e| format!("navigate failed: {e}"))?;
    // 页面加载后注入手机互联脚本（悬浮图标 + UI 层弹窗；脚本自带重试，覆盖加载时序）
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        let _ = win.eval(INJECT_JS);
    });
    Ok(())
}

/// 主局域网 IP：UDP connect 探测出站地址（不发包），取非 loopback 地址。
#[tauri::command]
fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr() {
        Ok(addr) if !addr.ip().is_loopback() => Some(addr.ip().to_string()),
        _ => None,
    }
}

#[tauri::command]
fn bridge_running() -> bool {
    bridge_listening()
}

/// 启动手机互联桥接服务（node 运行 mobile-h5 构建产物）。
/// 脚本位置：① DSH_UI_MOBILE_SERVER 环境变量 ② 打包进 bundle 的 Resources/mobile-bridge.js（release） ③ ../mobile-h5/dist-server/index.js（dev/monorepo）。
#[tauri::command]
fn start_bridge(app: tauri::AppHandle, state: State<'_, BridgeState>) -> Result<bool, String> {
    if bridge_listening() {
        return Ok(true);
    }
    // Tauri v2 打包后资源位于 <bundle>/Contents/Resources/resources/mobile-bridge.js（保留配置相对路径），
    // 部分环境也可能平铺在 Resources/ 下，两种情况都探测。
    let candidates = [
        std::env::var("DSH_UI_MOBILE_SERVER").ok(),
        app.path().resource_dir().ok().map(|d| d.join("resources/mobile-bridge.js").to_string_lossy().to_string()),
        app.path().resource_dir().ok().map(|d| d.join("mobile-bridge.js").to_string_lossy().to_string()),
        Some("../mobile-h5/dist-server/index.js".to_string()),
    ];
    let script = candidates
        .into_iter()
        .flatten()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| "桥接脚本未找到（请先 pnpm --filter @dsh-ui/mobile-h5 build）".to_string())?;
    let script = std::fs::canonicalize(&script).map_err(|e| format!("桥接脚本无效 {script}: {e}"))?;
    let child = Command::new(resolve_node())
        .arg(&script)
        .env("PATH", CHILD_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动桥接失败: {e}"))?;
    *state.0.lock().unwrap() = Some(child);
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if bridge_listening() {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if let Some(mut c) = state.0.lock().unwrap().take() {
        let _ = c.kill();
    }
    Err("桥接服务未在 5s 内就绪".to_string())
}

#[tauri::command]
fn harness_status(state: State<'_, HarnessState>) -> HarnessStatus {
    let running = state.0.lock().unwrap().is_some() || harness_listening();
    HarnessStatus {
        running,
        url: running.then(|| HARNESS_URL.to_string()),
    }
}

/// 共享启动逻辑：harness 已在运行则直接导航，否则 spawn + 等待就绪 + 导航。
fn do_start_harness(state: &State<'_, HarnessState>, app: &tauri::AppHandle) -> Result<HarnessStatus, String> {
    if state.0.lock().unwrap().is_some() || harness_listening() {
        navigate_to_harness(app)?;
        return Ok(HarnessStatus {
            running: true,
            url: Some(HARNESS_URL.to_string()),
        });
    }
    let dsh = resolve_dsh();
    let child = if dsh == "npx" {
        Command::new("npx")
            .args(["@deepseek-ai/dsh", "--profile", "web"])
            .env("PATH", CHILD_PATH)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    } else {
        Command::new(&dsh)
            .args(["--profile", "web"])
            .env("PATH", CHILD_PATH)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }
    .map_err(|e| format!("failed to start dsh: {e}"))?;
    *state.0.lock().unwrap() = Some(child);
    if !wait_for_harness(BOOT_TIMEOUT) {
        return Err(format!("harness 未在 {BOOT_TIMEOUT:?} 内就绪（{HARNESS_URL}）"));
    }
    navigate_to_harness(app)?;
    Ok(HarnessStatus {
        running: true,
        url: Some(HARNESS_URL.to_string()),
    })
}

#[tauri::command]
fn start_harness(state: State<'_, HarnessState>, app: tauri::AppHandle) -> Result<HarnessStatus, String> {
    do_start_harness(&state, &app)
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

fn kill_children(state: &State<'_, HarnessState>, bridge: &State<'_, BridgeState>) {
    for holder in [&state.0, &bridge.0] {
        if let Some(mut child) = holder.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 打开/聚焦手机互联扫码窗口。
fn open_mobile_qr_win(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("mobile-qr") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "mobile-qr", WebviewUrl::App("index.html".into()))
        .title("手机互联")
        .inner_size(430.0, 700.0)
        .resizable(true)
        .build();
}

/// 打开手机互联 UI 层弹窗：优先在 harness 主窗口内 eval 打开弹窗（UI 层弹窗，
/// 替代原系统级独立窗口）；主窗口不可用（harness 未加载）时回退原生扫码窗口。
fn open_mobile_qr_ui(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.__dshPhoneModal && window.__dshPhoneModal.open()");
        return;
    }
    open_mobile_qr_win(app);
}

/// 供注入的悬浮图标/菜单/托盘调用（前端 invoke 只能调已注册命令）。
#[tauri::command]
fn open_mobile_qr(app: tauri::AppHandle) -> Result<(), String> {
    open_mobile_qr_ui(&app);
    Ok(())
}

/// 启动公网隧道（代理到桥接服务 /tunnel/start，返回 {url, token} JSON）。
#[tauri::command]
fn start_tunnel() -> Result<String, String> {
    let out = Command::new("curl")
        .args(["-sS", "-m", "30", "-X", "POST", "http://127.0.0.1:4173/tunnel/start"])
        .output()
        .map_err(|e| format!("调用桥接服务失败: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 查询隧道状态（GET /tunnel）。
#[tauri::command]
fn tunnel_status() -> Result<String, String> {
    let out = Command::new("curl")
        .args(["-sS", "-m", "5", "http://127.0.0.1:4173/tunnel"])
        .output()
        .map_err(|e| format!("调用桥接服务失败: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 菜单与托盘共用的事件分发。
fn dispatch_menu(app: &tauri::AppHandle, id: &str) {
    match id {
        "mobile-qr" => open_mobile_qr_ui(app),
        "open-main" => {
            let _ = navigate_to_harness(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(HarnessState(Mutex::new(None)))
        .manage(BridgeState(Mutex::new(None)))
        .setup(|app| {
            let open_main = MenuItem::with_id(app, "open-main", "打开主界面", true, None::<&str>)?;
            let mobile = MenuItem::with_id(app, "mobile-qr", "手机互联（扫码访问）", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_main, &mobile, &quit])?;
            app.set_menu(menu.clone())?;
            // 系统托盘：菜单栏常驻入口，更醒目
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("DeepSeek Harness UI")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| dispatch_menu(app, event.id().as_ref()))
                .build(app)?;
            // 启动后自动进入 harness 首页（无需点击）
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(600));
                let state = handle.state::<HarnessState>();
                let _ = do_start_harness(&state, &handle);
            });
            // 启动后自动拉起手机互联连接服务（后台静默）：用户打开弹窗即出二维码，无需任何手动操作
            let bridge_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let state = bridge_handle.state::<BridgeState>();
                let _ = start_bridge(bridge_handle.clone(), state);
            });
            Ok(())
        })
        .on_menu_event(|app, event| dispatch_menu(app, event.id().as_ref()))
        // 注入图标的兜底触发通道：dshui://open-mobile-qr 打开扫码窗口
        .register_uri_scheme_protocol("dshui", |ctx, request| {
            if request.uri().to_string().contains("open-mobile-qr") {
                open_mobile_qr_ui(ctx.app_handle());
            }
            tauri::http::Response::builder()
                .status(204)
                .body(Vec::new())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            harness_status,
            start_harness,
            stop_harness,
            lan_ip,
            bridge_running,
            start_bridge,
            open_mobile_qr,
            start_tunnel,
            tunnel_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let h = app.state::<HarnessState>();
                let b = app.state::<BridgeState>();
                kill_children(&h, &b);
            }
        });
}
