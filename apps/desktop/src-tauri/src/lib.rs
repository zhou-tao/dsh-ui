//! dsh-ui desktop shell: owns the harness web-profile process and points the
//! main window at its UI; provides the phone-companion QR entry (mobile-h5 bridge).
use std::net::{TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

const HARNESS_HOST: &str = "127.0.0.1";
const DEFAULT_HARNESS_PORT: u16 = 3080;
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const BRIDGE_PORT: u16 = 4173;

/// harness 端口：DSH_UI_PORT 环境变量覆盖（默认 3080）。
/// 便于端口冲突时换端口（与 README 的说明一致）。
fn harness_port() -> u16 {
    std::env::var("DSH_UI_PORT")
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_HARNESS_PORT)
}

/// harness 首页地址（跟随 DSH_UI_PORT）。
fn harness_url() -> String {
    format!("http://{HARNESS_HOST}:{}", harness_port())
}

/// Finder/Dock 启动的 GUI app 其 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
/// `Command::new("node")` 会直接 ENOENT —— 必须用绝对路径解析 node。
#[cfg(not(target_os = "windows"))]
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("DSH_UI_NODE") {
        if !p.trim().is_empty() && Path::new(p.trim()).exists() {
            return p.trim().to_string();
        }
    }
    for cand in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
        if Path::new(cand).exists() {
            return cand.to_string();
        }
    }
    "node".to_string() // 开发环境 PATH 兜底
}

/// Windows：GUI 应用继承完整用户 PATH，node 通常可直接解析；仍补常见安装路径。
#[cfg(target_os = "windows")]
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("DSH_UI_NODE") {
        if !p.trim().is_empty() && Path::new(p.trim()).exists() {
            return p.trim().to_string();
        }
    }
    // where node（CreateProcess 会按 PATH 找 node.exe）
    if let Ok(out) = Command::new("where").arg("node").output() {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let p = line.trim();
                if !p.is_empty() && Path::new(p).exists() {
                    return p.to_string();
                }
            }
        }
    }
    // 常见安装位置兜底（node 通常装在 Program Files\nodejs）
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let cand = Path::new(&pf).join("nodejs").join("node.exe");
        if cand.exists() {
            return cand.to_string_lossy().to_string();
        }
    }
    "node".to_string()
}

/// 子进程 PATH：保证 node / cloudflared / npx 等外部命令可解析（覆盖 Finder 启动的极简 PATH）。
/// Windows 无需覆盖（GUI 应用继承完整用户 PATH，且路径分隔符为 ';'）。
#[cfg(not(target_os = "windows"))]
const CHILD_PATH: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

fn on_path(name: &str) -> bool {
    let mut cmd = if cfg!(target_os = "windows") {
        // Windows 用 where 探测 PATH（也覆盖 .cmd shim）
        let mut c = Command::new("where");
        c.arg(name);
        c
    } else {
        let mut c = Command::new("/usr/bin/which");
        c.arg(name);
        #[cfg(not(target_os = "windows"))]
        c.env("PATH", CHILD_PATH);
        c
    };
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 解析 dsh 启动方式：PATH 上的 dsh → npx @deepseek-ai/dsh（本机经 npx 缓存运行）→ 常见绝对路径。
/// Windows 下 npm 全局安装会生成 dsh.cmd / npx.cmd shim，需按扩展名探测。
fn resolve_dsh() -> String {
    if let Ok(p) = std::env::var("DSH_UI_DSH") {
        if !p.trim().is_empty() {
            return p.trim().to_string();
        }
    }
    #[cfg(target_os = "windows")]
    {
        // npm 全局 shim（.cmd 优先）+ 裸命令
        for name in ["dsh.cmd", "dsh.exe", "dsh"] {
            if on_path(name) {
                return name.to_string();
            }
        }
        // npm 全局目录兜底（npm prefix -g 默认 %APPDATA%\npm）
        if let Ok(appdata) = std::env::var("APPDATA") {
            for name in ["dsh.cmd", "dsh.exe", "dsh"] {
                let p = Path::new(&appdata).join("npm").join(name);
                if p.exists() {
                    return p.to_string_lossy().to_string();
                }
            }
        }
        for name in ["npx.cmd", "npx.exe", "npx"] {
            if on_path(name) {
                return name.to_string();
            }
        }
        return "dsh.cmd".to_string();
    }
    #[cfg(not(target_os = "windows"))]
    {
        if on_path("dsh") {
            return "dsh".to_string();
        }
        if on_path("npx") {
            return "npx".to_string();
        }
        for cand in ["/usr/local/bin/dsh", "/opt/homebrew/bin/dsh"] {
            if Path::new(cand).exists() {
                return cand.to_string();
            }
        }
        "dsh".to_string()
    }
}

/// 给子进程注入 PATH：macOS/Linux 需显式补全（Finder/Dock 启动的 GUI PATH 极简），
/// Windows GUI 应用继承完整用户 PATH，无需覆盖。
fn apply_child_path(cmd: &mut Command) -> &mut Command {
    #[cfg(not(target_os = "windows"))]
    cmd.env("PATH", CHILD_PATH);
    cmd
}

/// 启动 harness 子进程。
/// - Unix：直接 spawn dsh / npx。
/// - Windows：npm 全局安装生成的是 .cmd shim，CreateProcess 不能直接执行批处理，
///   需经 cmd /C call 包装（保留路径引号语义，避免 cmd 引号剥离问题）。
/// - npx 场景加 `--yes`：首次运行 npx 会提示交互确认安装（"Ok to proceed?"），
///   GUI 内 stdin 为空会导致确认失败/挂起；`--yes` 直接放行（已装则无副作用）。
fn spawn_harness(dsh: &str) -> std::io::Result<Child> {
    let is_npx = dsh == "npx" || dsh.ends_with("npx.cmd") || dsh.ends_with("npx.exe");
    // Windows 下非 .exe（.cmd/.bat shim 或裸命令名）都需经 cmd /C call 包装
    let needs_cmd_wrap = cfg!(target_os = "windows") && !dsh.ends_with(".exe");
    let mut cmd = if needs_cmd_wrap {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("call").arg(dsh);
        c
    } else {
        Command::new(dsh)
    };
    if is_npx {
        cmd.arg("--yes").arg("@deepseek-ai/dsh");
    }
    cmd.arg("--profile").arg("web");
    // 端口跟随 DSH_UI_PORT（默认 3080），与 harness_listening/harness_url 保持一致
    if harness_port() != DEFAULT_HARNESS_PORT {
        cmd.arg("--port").arg(harness_port().to_string());
    }
    let _ = apply_child_path(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
}

// ---------- plugins/ 自动安装到 harness profile（issue #2） ----------

/// dsh 数据目录：DSH_HOME 环境变量 > 用户主目录/.dsh。
fn dsh_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(h) = std::env::var("DSH_HOME") {
        let h = h.trim();
        if !h.is_empty() {
            return Ok(PathBuf::from(h));
        }
    }
    app.path()
        .home_dir()
        .map(|h| h.join(".dsh"))
        .map_err(|e| format!("无法获取用户主目录: {e}"))
}

/// 当前 harness profile 目录（默认 web，可用 DSH_PROFILE 覆盖）。
fn dsh_profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let profile = std::env::var("DSH_PROFILE").unwrap_or_else(|_| "web".to_string());
    Ok(dsh_home_dir(app)?.join("profiles").join(profile))
}

/// 定位插件包目录：① DSH_UI_PLUGINS_DIR 环境变量 ② 打包资源（release） ③ monorepo dev 路径。
fn plugin_source_dir(app: &tauri::AppHandle, id: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("DSH_UI_PLUGINS_DIR") {
        let p = Path::new(&dir).join(id);
        if p.join("package.json").exists() {
            return Some(p);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        for base in [res.join("plugins").join(id), res.join("resources/plugins").join(id)] {
            if base.join("package.json").exists() {
                return Some(base);
            }
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins").join(id);
    if manifest.join("package.json").exists() {
        return Some(manifest);
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("plugins").join(id);
        if p.join("package.json").exists() {
            return Some(p);
        }
    }
    None
}

/// 复制目录（符号链接失败时的回退，Windows 无管理员权限时）。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 先符号链接，失败则整目录复制。
fn link_or_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        if std::os::unix::fs::symlink(src, dst).is_ok() {
            return Ok(());
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Windows 目录符号链接需管理员/开发者模式，直接复制更稳
        return copy_dir_recursive(src, dst);
    }
    #[cfg(not(target_os = "windows"))]
    copy_dir_recursive(src, dst)
}

/// 把 plugins/ 下的插件自动装进 harness profile（幂等）：
/// ① cordis.patch.yml insert 块 ② package.json file: 依赖 ③ node_modules/<id> 链接/复制。
/// 返回是否安装了新内容（true 表示需要重启 harness 生效）。
fn ensure_plugins_installed(app: &tauri::AppHandle) -> Result<bool, String> {
    let profile_dir = dsh_profile_dir(app)?;
    let patch_file = profile_dir.join("cordis.patch.yml");
    let pkg_file = profile_dir.join("package.json");
    if !profile_dir.exists() {
        return Ok(false); // 首次运行：harness 启动时创建 profile，稍后由调用方补装
    }
    if !patch_file.exists() {
        return Ok(false); // harness 尚未初始化完成
    }
    let plugins = [
        ("dsh-deep-ui", "UI 层增强（会话思考过程折叠）"),
        ("dsh-remote", "手机互联（H5 远程互联）"),
    ];
    let mut changed = false;

    // 1) cordis.patch.yml：追加 insert 块（兼容空占位 []）
    let patch = std::fs::read_to_string(&patch_file).map_err(|e| e.to_string())?;
    let missing: Vec<&str> = plugins.iter().map(|p| p.0).filter(|id| !patch.contains(id)).collect();
    if !missing.is_empty() {
        let mark = "# ── dsh-ui 插件（安装脚本生成；--remove 可移除） ──";
        let block = format!(
            "
{}
- insert:
{}",
            mark,
            missing.iter().map(|id| format!("    - id: {id}
      name: '{id}'")).collect::<Vec<_>>().join("
")
        );
        let new_patch = if patch.trim() == "[]" {
            let kept = patch.lines().filter(|l| l.trim() != "[]").collect::<Vec<_>>().join("
");
            format!("{}
{}", kept, block.trim_start())
        } else {
            format!("{}
{}", patch.trim_end(), block)
        };
        std::fs::write(&patch_file, new_patch).map_err(|e| e.to_string())?;
        changed = true;
    }

    // 2) package.json：file: 依赖（与脚本一致，便于后续 pnpm install --remove 对齐）
    if pkg_file.exists() {
        let text = std::fs::read_to_string(&pkg_file).map_err(|e| e.to_string())?;
        let mut pkg: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("解析 {pkg_file:?} 失败: {e}"))?;
        if pkg.get("dependencies").is_none() {
            pkg["dependencies"] = serde_json::json!({});
        }
        let deps = pkg["dependencies"].as_object_mut().unwrap();
        let mut dirty = false;
        for (id, _) in &plugins {
            if let Some(src) = plugin_source_dir(app, id) {
                let dep = format!("file:{}", src.display());
                let existing = deps.get(*id).and_then(|v| v.as_str());
                if existing != Some(dep.as_str()) {
                    deps.insert((*id).to_string(), serde_json::Value::String(dep));
                    dirty = true;
                }
            }
        }
        if dirty {
            let out = serde_json::to_string_pretty(&pkg).map_err(|e| e.to_string())? + "
";
            std::fs::write(&pkg_file, out).map_err(|e| e.to_string())?;
            changed = true;
        }
    }

    // 3) node_modules/<id>：无 pnpm 也能解析（与 pnpm install 生成的符号链接等价）
    let nm = profile_dir.join("node_modules");
    for (id, _) in &plugins {
        if let Some(src) = plugin_source_dir(app, id) {
            let link = nm.join(id);
            if !link.exists() {
                std::fs::create_dir_all(&nm).map_err(|e| e.to_string())?;
                link_or_copy(&src, &link).map_err(|e| format!("安装插件 {id} 失败: {e}"))?;
                changed = true;
            }
        }
    }

    Ok(changed)
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
    TcpStream::connect((HARNESS_HOST, harness_port())).is_ok()
}

fn bridge_listening() -> bool {
    TcpStream::connect(("127.0.0.1", BRIDGE_PORT)).is_ok()
}

/// 等待 harness 就绪；若子进程提前退出则读取其 stderr 用于诊断。
/// 返回 Err 时附带进程退出码与最后一段输出，便于用户/issue 排查。
fn wait_for_harness(timeout: Duration, child: &mut Child) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if harness_listening() {
            return Ok(());
        }
        // 子进程提前退出（如 npx 未装成、dsh 崩溃）：读取 stderr 给出原因
        if let Some(status) = child.try_wait().map_err(|e| format!("wait dsh failed: {e}"))? {
            let mut buf = String::new();
            let _ = child.stderr.take().and_then(|mut s| {
                use std::io::Read;
                let _ = s.read_to_string(&mut buf);
                Some(())
            });
            let diag = if buf.trim().is_empty() {
                "（无输出）".to_string()
            } else {
                buf.trim().lines().rev().take(12).collect::<Vec<_>>().join(" | ")
            };
            return Err(format!("dsh 进程提前退出（code={status}）：{diag}"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if harness_listening() {
        Ok(())
    } else {
        Err(format!("harness 未在 {timeout:?} 内就绪（{}）", harness_url()))
    }
}

fn navigate_to_harness(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };
    let target = harness_url()
        .parse::<tauri::Url>()
        .map_err(|e| format!("bad harness url {}: {e}", harness_url()))?;
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
    let mut bridge_cmd = Command::new(resolve_node());
    bridge_cmd.arg(&script);
    let _ = apply_child_path(&mut bridge_cmd);
    let child = bridge_cmd
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
        url: running.then(|| harness_url()),
    }
}

/// 共享启动逻辑：harness 已在运行则直接导航，否则 spawn + 等待就绪 + 导航。
/// 启动前自动把 plugins/ 下的插件装进 harness profile（幂等；首次运行 profile 创建后再补装并重启一次）。
fn do_start_harness(state: &State<'_, HarnessState>, app: &tauri::AppHandle) -> Result<HarnessStatus, String> {
    if state.0.lock().unwrap().is_some() || harness_listening() {
        // 已在运行：补装插件（幂等，下次重启生效），直接导航
        let _ = ensure_plugins_installed(app);
        navigate_to_harness(app)?;
        return Ok(HarnessStatus {
            running: true,
            url: Some(harness_url()),
        });
    }
    // 启动前先确保插件已安装（profile 已存在时立即生效）
    let profile_exists = dsh_profile_dir(app).map(|d| d.exists()).unwrap_or(false);
    let installed = ensure_plugins_installed(app).unwrap_or(false);
    let dsh = resolve_dsh();
    let mut child = spawn_harness(&dsh).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "failed to start dsh: 未找到 dsh（{dsh}）。请先安装：npm i -g @deepseek-ai/dsh，或用环境变量 DSH_UI_DSH 指定 dsh 可执行文件路径"
            )
        } else {
            format!("failed to start dsh: {e}")
        }
    })?;
    wait_for_harness(BOOT_TIMEOUT, &mut child)?;
    *state.0.lock().unwrap() = Some(child);
    // 首次运行：profile 由本次启动创建 → 补装插件并重启一次使其生效
    if !profile_exists && !installed {
        if ensure_plugins_installed(app).unwrap_or(false) {
            if let Some(mut c) = state.0.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            let mut child = spawn_harness(&dsh).map_err(|e| format!("failed to restart dsh: {e}"))?;
            wait_for_harness(BOOT_TIMEOUT, &mut child)?;
            *state.0.lock().unwrap() = Some(child);
        }
    }
    navigate_to_harness(app)?;
    Ok(HarnessStatus {
        running: true,
        url: Some(harness_url()),
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
/// 替代原系统级独立窗口）；主窗口不可用 / 弹窗未注入（harness 未加载、启动错误弹窗等）时
/// 回退原生扫码窗口。
fn open_mobile_qr_ui(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let handle = app.clone();
        // 结果会被 JSON 序列化：true / false（字符串）
        let _ = win.eval_with_callback(
            "window.__dshPhoneModal ? (window.__dshPhoneModal.open(), true) : false",
            move |res| {
                if res.trim() != "true" {
                    // 窗口创建必须在主线程（Tauri v2 约束）
                    let handle = handle.clone();
                    let handle2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || open_mobile_qr_win(&handle2));
                }
            },
        );
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
            // 标准 Edit 菜单（macOS 必需：WKWebView 的 Cmd+C/V 依赖菜单栏转发；
            // PredefinedMenuItem 会自动连接系统编辑动作，Windows/Linux 上同样生效）
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None::<&str>)?,
                    &PredefinedMenuItem::redo(app, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None::<&str>)?,
                    &PredefinedMenuItem::copy(app, None::<&str>)?,
                    &PredefinedMenuItem::paste(app, None::<&str>)?,
                    &PredefinedMenuItem::select_all(app, None::<&str>)?,
                ],
            )?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_main, &mobile, &edit_menu, &quit])?;
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
