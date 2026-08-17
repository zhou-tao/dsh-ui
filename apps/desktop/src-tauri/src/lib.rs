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

/// 注入到 harness 页面的手机图标：插入 hHd-Xa_settingsArea（设置按钮右侧，flex 子元素 + 状态绿点）。
const INJECT_JS: &str = r#"(() => {
  if (document.getElementById('dsh-phone-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'dsh-phone-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', '手机互联');
  fab.title = '手机互联（扫码连接）';
  fab.style.cssText = 'cursor:pointer;width:28px;height:28px;border-radius:50%;background:#3d7eff;color:#fff;border:none;display:inline-flex;align-items:center;justify-content:center;font-size:15px;padding:0;margin-left:6px;flex:none;position:relative;';
  fab.textContent = '📱';
  const dot = document.createElement('span');
  dot.id = 'dsh-phone-dot';
  dot.style.cssText = 'position:absolute;top:-1px;right:-1px;width:9px;height:9px;border-radius:50%;border:2px solid #fff;background:#8b949e;';
  fab.appendChild(dot);
  const inject = () => {
    const area = document.querySelector('.hHd-Xa_settingsArea, [class*="settingsArea"]');
    if (area && !area.contains(fab)) { area.appendChild(fab); return true; }
    return !!area && area.contains(fab);
  };
  let tries = 0;
  const timer = setInterval(() => { if (inject() || ++tries > 30) clearInterval(timer); }, 500);
  let mo = null;
  try {
    mo = new MutationObserver(() => { if (inject()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* observer 不可用时仅轮询 */ }
  // 15s 后 settingsArea 仍未出现：回退到左下角固定位置
  setTimeout(() => { if (!inject() && !document.getElementById('dsh-phone-fab') && document.body) {
    fab.style.position = 'fixed';
    fab.style.left = '64px';
    fab.style.bottom = '8px';
    fab.style.zIndex = '2147483000';
    document.body.appendChild(fab);
  } }, 15000);
  const setDot = (ok) => { dot.style.background = ok ? '#56d364' : '#ff5f56'; };
  const ping = () => {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('bridge_running').then(setDot).catch(() => setDot(false));
      } else setDot(false);
    } catch { setDot(false); }
  };
  ping();
  setInterval(ping, 5000);
  fab.addEventListener('click', () => {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('open_mobile_qr');
      } else alert('手机互联：请从桌面端菜单/托盘打开扫码窗口');
    } catch (e) { alert('手机互联：' + e.message); }
  });
})();"#;

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
    // 页面加载后注入左下角手机图标（注入脚本自带重试，覆盖加载时序）
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
    let candidates = [
        std::env::var("DSH_UI_MOBILE_SERVER").ok(),
        app.path().resource_dir().ok().map(|d| d.join("mobile-bridge.js").to_string_lossy().to_string()),
        Some("../mobile-h5/dist-server/index.js".to_string()),
    ];
    let script = candidates
        .into_iter()
        .flatten()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| "桥接脚本未找到（请先 pnpm --filter @dsh-ui/mobile-h5 build）".to_string())?;
    let script = std::fs::canonicalize(&script).map_err(|e| format!("桥接脚本无效 {script}: {e}"))?;
    let child = Command::new("node")
        .arg(&script)
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

/// 供注入的悬浮图标调用（前端 invoke 只能调已注册命令）。
#[tauri::command]
fn open_mobile_qr(app: tauri::AppHandle) -> Result<(), String> {
    open_mobile_qr_win(&app);
    Ok(())
}

/// 在 harness 页面注入左下角手机图标（进入界面后调用）。
fn inject_phone_icon(win: &tauri::WebviewWindow) {
    let _ = win.eval(INJECT_JS);
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
        "mobile-qr" => open_mobile_qr_win(app),
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
                .tooltip("DeepSeek Harness")
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
            Ok(())
        })
        .on_menu_event(|app, event| dispatch_menu(app, event.id().as_ref()))
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

