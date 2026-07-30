#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tauri::{Manager, RunEvent, State};

static API_PORT: AtomicU32 = AtomicU32::new(0);
static SERVER_PID: AtomicU32 = AtomicU32::new(0);
static OWNED: AtomicU32 = AtomicU32::new(0); // 1 = we started it

struct ApprovedDestination {
    root: PathBuf,
    expires: Instant,
}

struct ServerState {
    child: Mutex<Option<Child>>,
    instance_nonce: String,
    approved_destinations: Mutex<Vec<ApprovedDestination>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DestinationGrantResult {
    status: String,
    destination_grant_id: Option<String>,
    expires_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendDestinationGrant {
    id: String,
    expires_at: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IdeLaunchResult {
    exported_path: String,
    launch_status: String,
}

fn port() -> u16 { API_PORT.load(Ordering::SeqCst) as u16 }

fn requested_port() -> u16 {
    if cfg!(debug_assertions) {
        std::env::var("MYPATH_API_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(0)
    } else { 0 }
}

fn health_ok(api_port: u16, nonce: &str) -> bool {
    if api_port == 0 { return false; }
    let addr = format!("127.0.0.1:{api_port}");
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(300)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{api_port}\r\nX-MyPath-Instance: {nonce}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() { return false; }
    let mut buf = String::new(); let _ = stream.read_to_string(&mut buf);
    buf.contains("200") && buf.contains("\"product\":\"mypath\"") && buf.contains("\"instanceAuthenticated\":true")
}

fn wait_healthy(api_port: u16, nonce: &str, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if health_ok(api_port, nonce) { return Ok(()); }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!("Authenticated MyPath server did not become healthy on dynamic port {api_port} within {timeout:?}"))
}

fn is_mypath_root(dir: &Path) -> bool {
    dir.join("server/index.js").is_file() && (dir.join(".runtime/web/index.html").is_file() || dir.join("web/index.html").is_file())
}

fn resolve_root() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("MYPATH_ROOT") {
        let p = PathBuf::from(raw);
        if is_mypath_root(&p) {
            return Ok(p);
        }
        return Err(format!("MYPATH_ROOT is not a MyPath project: {}", p.display()));
    }

    if let Ok(cwd) = std::env::current_dir() {
        if is_mypath_root(&cwd) {
            return Ok(cwd);
        }
        let mut d = cwd;
        for _ in 0..8 {
            if is_mypath_root(&d) {
                return Ok(d);
            }
            if !d.pop() {
                break;
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut d = exe.parent().unwrap_or(Path::new("/")).to_path_buf();
        for _ in 0..10 {
            if is_mypath_root(&d) {
                return Ok(d);
            }
            if d.file_name().and_then(|s| s.to_str()) == Some("MacOS") {
                for rel in [
                    "Resources/mypath",
                    "Resources/resources/mypath",
                    "Resources/resources/mypath/mypath",
                ] {
                    if let Some(res) = d.parent().map(|p| p.join(rel)) {
                        if is_mypath_root(&res) {
                            return Ok(res);
                        }
                    }
                }
            }
            if !d.pop() {
                break;
            }
        }
    }

    Err(
        "Could not find MyPath project root (server/index.js + web/index.html). Set MYPATH_ROOT."
            .into(),
    )
}

fn resolve_node(root: &Path) -> Result<PathBuf, String> {
    let bundled = root.join("bin/node");
    if bundled.is_file() { return Ok(bundled); }
    if !cfg!(debug_assertions) { return Err("Packaged runtime is missing its pinned Node sidecar".into()); }
    if let Ok(n) = std::env::var("MYPATH_NODE") {
        let p = PathBuf::from(n);
        if p.is_file() {
            return Ok(p);
        }
    }

    if let Ok(output) = Command::new("/usr/bin/which").arg("node").output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() && Path::new(&s).is_file() {
                return Ok(PathBuf::from(s));
            }
        }
    }

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
    ];
    if let Some(home) = home {
        let nvm = home.join(".nvm/versions/node");
        if nvm.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&nvm) {
                let mut vers: Vec<_> = rd.filter_map(|e| e.ok()).collect();
                vers.sort_by_key(|e| e.file_name());
                for e in vers.into_iter().rev() {
                    candidates.push(e.path().join("bin/node"));
                }
            }
        }
    }
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err("Could not find Node.js. Install Node or set MYPATH_NODE.".into())
}

fn data_dir(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("MYPATH_DATA_DIR") {
        return PathBuf::from(raw);
    }
    if cfg!(debug_assertions) {
        return root.join("data");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.to_path_buf())
        .join("Library/Application Support/local.mypath.desktop")
}

fn pidfile_path(data: &Path) -> PathBuf {
    data.join("desktop-server.pid")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PidRecord {
    pid: u32,
    identity: String,
}

fn process_identity(pid: u32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "lstart=,command="])
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let identity = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if identity.is_empty() { None } else { Some(identity) }
}

fn write_pidfile(data: &Path, pid: u32) {
    let _ = std::fs::create_dir_all(data);
    for _ in 0..5 {
        if let Some(identity) = process_identity(pid) {
            let record = PidRecord { pid, identity };
            if let Ok(encoded) = serde_json::to_vec(&record) {
                let _ = std::fs::write(pidfile_path(data), encoded);
            }
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn clear_pidfile(data: &Path) {
    let _ = std::fs::remove_file(pidfile_path(data));
}

#[cfg(unix)]
fn unix_kill(pid: i32, sig: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        kill(pid, sig);
    }
}

fn kill_server_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        const SIGTERM: i32 = 15;
        const SIGKILL: i32 = 9;
        // process group (if we set one) + direct pid
        unix_kill(-(pid as i32), SIGTERM);
        unix_kill(pid as i32, SIGTERM);
        thread::sleep(Duration::from_millis(350));
        unix_kill(-(pid as i32), SIGKILL);
        unix_kill(pid as i32, SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

fn stop_owned_server() {
    if OWNED.load(Ordering::SeqCst) != 1 {
        return;
    }
    let pid = SERVER_PID.swap(0, Ordering::SeqCst);
    kill_server_pid(pid);
    API_PORT.store(0, Ordering::SeqCst);
    OWNED.store(0, Ordering::SeqCst);
    if let Ok(root) = resolve_root() {
        clear_pidfile(&data_dir(&root));
    }
}

#[cfg(unix)]
extern "C" fn on_signal(_sig: i32) {
    stop_owned_server();
    // hard exit after cleanup
    extern "C" {
        fn _exit(code: i32) -> !;
    }
    unsafe { _exit(0) }
}

#[cfg(unix)]
fn install_signal_handlers() {
    extern "C" {
        fn signal(sig: i32, handler: usize) -> usize;
    }
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;
    unsafe {
        signal(SIGINT, on_signal as *const () as usize);
        signal(SIGTERM, on_signal as *const () as usize);
    }
}

fn instance_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|e| format!("instance nonce: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupDescriptor {
    schema: String,
    pid: u32,
    port: u16,
    started_at: String,
    authentication: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSmokeDescriptor<'a> {
    schema: &'static str,
    desktop_pid: u32,
    server_pid: u32,
    port: u16,
    instance_nonce: &'a str,
}

fn write_desktop_smoke_descriptor(instance_nonce: &str) -> Result<(), String> {
    let Some(path) = std::env::var_os("MYPATH_DESKTOP_SMOKE_DESCRIPTOR").map(PathBuf::from) else { return Ok(()); };
    let descriptor = DesktopSmokeDescriptor {
        schema: "MyPathDesktopSmokeDescriptorV1",
        desktop_pid: std::process::id(),
        server_pid: SERVER_PID.load(Ordering::SeqCst),
        port: port(),
        instance_nonce,
    };
    let bytes = serde_json::to_vec(&descriptor).map_err(|error| format!("desktop smoke descriptor JSON: {error}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| format!("desktop smoke descriptor {}: {error}", path.display()))?;
    file.write_all(&bytes).map_err(|error| format!("desktop smoke descriptor write: {error}"))?;
    file.sync_all().map_err(|error| format!("desktop smoke descriptor sync: {error}"))
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 { return Err("descriptor authentication is not hex".into()); }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| "descriptor authentication is not hex".into())).collect()
}

fn wait_descriptor(path: &Path, expected_pid: u32, nonce: &str, timeout: Duration) -> Result<StartupDescriptor, String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(bytes) = std::fs::read(path) {
            let descriptor: StartupDescriptor = serde_json::from_slice(&bytes).map_err(|error| format!("startup descriptor JSON: {error}"))?;
            if descriptor.schema != "MyPathStartupDescriptorV1" || descriptor.pid != expected_pid || descriptor.port == 0 {
                return Err("startup descriptor identity does not match the spawned sidecar".into());
            }
            let message = format!("{}:{}:{}", descriptor.pid, descriptor.port, descriptor.started_at);
            let mut mac = Hmac::<Sha256>::new_from_slice(nonce.as_bytes()).map_err(|error| error.to_string())?;
            mac.update(message.as_bytes());
            mac.verify_slice(&decode_hex(&descriptor.authentication)?).map_err(|_| "startup descriptor authentication failed".to_string())?;
            return Ok(descriptor);
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("Timed out waiting for authenticated startup descriptor".into())
}

fn start_server(state: &ServerState, instance_nonce: &str) -> Result<(), String> {
    // Never probe or attach to an existing fixed-port service. This process always
    // spawns its own backend on port zero and trusts only its HMAC-authenticated
    // descriptor from the exact child PID.
    let root = resolve_root()?;
    let node = resolve_node(&root)?;
    let data = data_dir(&root);
    let _ = std::fs::create_dir_all(&data);
    let legacy_source = root.join("data/db.json");
    let legacy_destination = data.join("db.json");
    if !data.join("db.sqlite").exists() && !legacy_destination.exists() && legacy_source.is_file() {
        std::fs::copy(&legacy_source, &legacy_destination).map_err(|e| format!("legacy data copy: {e}"))?;
        let _ = std::fs::write(data.join("legacy-source.txt"), legacy_source.display().to_string());
    }

    if let Ok(encoded) = std::fs::read(pidfile_path(&data)) {
        if let Ok(record) = serde_json::from_slice::<PidRecord>(&encoded) {
            let matches_owned_server = process_identity(record.pid).map(|identity| identity == record.identity && identity.contains("server/index.js")).unwrap_or(false);
            if matches_owned_server { kill_server_pid(record.pid); thread::sleep(Duration::from_millis(200)); }
        }
        clear_pidfile(&data);
    }

    let descriptor_path = data.join(format!("startup-{}-{}.json", std::process::id(), &instance_nonce[..12]));
    let _ = std::fs::remove_file(&descriptor_path);
    let log_path = data.join("desktop-server.log");
    let log_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| format!("log open: {e}"))?;
    let log_err = log_file.try_clone().map_err(|e| format!("log clone: {e}"))?;

    let selected_port = requested_port();
    let mut cmd = Command::new(&node);
    cmd.arg("server/index.js")
        .current_dir(&root)
        .env("MYPATH_API_PORT", selected_port.to_string())
        .env("PORT", selected_port.to_string())
        .env("MYPATH_DATA_DIR", &data)
        .env("MYPATH_INSTANCE_NONCE", instance_nonce)
        .env("MYPATH_STARTUP_DESCRIPTOR", &descriptor_path)
        .stdout(Stdio::from(log_file)).stderr(Stdio::from(log_err));

    let path = if cfg!(debug_assertions) {
        format!("{}:/usr/bin:/bin:{}", node.parent().unwrap_or(Path::new("/usr/bin")).display(), std::env::var("PATH").unwrap_or_default())
    } else { format!("{}:/usr/bin:/bin", node.parent().unwrap_or(Path::new("/usr/bin")).display()) };
    cmd.env("PATH", path);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe { cmd.pre_exec(|| { extern "C" { fn setpgid(pid: i32, pgid: i32) -> i32; } let _ = setpgid(0, 0); Ok(()) }); }
    }

    let child = cmd.spawn().map_err(|e| format!("failed to spawn bundled Node sidecar: {e}"))?;
    let pid = child.id();
    SERVER_PID.store(pid, Ordering::SeqCst); OWNED.store(1, Ordering::SeqCst); write_pidfile(&data, pid);
    *state.child.lock().unwrap() = Some(child);

    let descriptor = match wait_descriptor(&descriptor_path, pid, instance_nonce, Duration::from_secs(15)) {
        Ok(value) => value,
        Err(error) => {
            let status = state.child.lock().unwrap().as_mut().and_then(|child| child.try_wait().ok().flatten());
            kill_server_pid(pid); clear_pidfile(&data);
            return Err(format!("{error}; child status {status:?}. See {}", log_path.display()));
        }
    };
    let _ = std::fs::remove_file(&descriptor_path);
    API_PORT.store(descriptor.port as u32, Ordering::SeqCst);
    if let Err(error) = wait_healthy(descriptor.port, instance_nonce, Duration::from_secs(15)) {
        kill_server_pid(pid); clear_pidfile(&data); API_PORT.store(0, Ordering::SeqCst); OWNED.store(0, Ordering::SeqCst);
        return Err(error);
    }
    Ok(())
}

fn post_native_json(route: &str, nonce: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let encoded = serde_json::to_vec(body).map_err(|error| format!("encode native request: {error}"))?;
    let address = format!("127.0.0.1:{}", port());
    let mut stream = TcpStream::connect_timeout(&address.parse().unwrap(), Duration::from_secs(2))
        .map_err(|error| format!("connect native channel: {error}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|error| error.to_string())?;
    let request = format!(
        "POST {route} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nContent-Type: application/json\r\nX-MyPath-Instance: {nonce}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        port(), encoded.len()
    );
    stream.write_all(request.as_bytes()).and_then(|_| stream.write_all(&encoded)).map_err(|error| format!("write native request: {error}"))?;
    let mut response = Vec::new(); stream.read_to_end(&mut response).map_err(|error| format!("read native response: {error}"))?;
    let boundary = response.windows(4).position(|window| window == b"\r\n\r\n").ok_or("invalid native HTTP response")?;
    let head = String::from_utf8_lossy(&response[..boundary]);
    let status = head.split_whitespace().nth(1).and_then(|value| value.parse::<u16>().ok()).unwrap_or(500);
    let value: serde_json::Value = serde_json::from_slice(&response[boundary + 4..]).map_err(|error| format!("decode native response: {error}"))?;
    if !(200..300).contains(&status) { return Err(value.pointer("/error/message").and_then(|item| item.as_str()).unwrap_or("native backend request failed").to_string()); }
    Ok(value)
}

fn path_is_inside(root: &Path, target: &Path) -> bool {
    target != root && target.strip_prefix(root).is_ok()
}

#[tauri::command]
fn pick_export_destination(state: State<'_, ServerState>) -> Result<DestinationGrantResult, String> {
    #[cfg(target_os = "macos")]
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", "POSIX path of (choose folder with prompt \"Choose a MyPath export destination\")"])
        .stdin(Stdio::null()).output().map_err(|error| format!("directory picker unavailable: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    return Ok(DestinationGrantResult { status: "unavailable".into(), destination_grant_id: None, expires_at: None });
    #[cfg(target_os = "macos")]
    {
        if !output.status.success() { return Ok(DestinationGrantResult { status: "cancelled".into(), destination_grant_id: None, expires_at: None }); }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let canonical = std::fs::canonicalize(&selected).map_err(|error| format!("canonicalize selected destination: {error}"))?;
        if !canonical.is_dir() { return Err("Selected export destination is not a directory".into()); }
        let value = post_native_json("/api/v1/native/export-destination-grants", &state.instance_nonce, &serde_json::json!({ "canonicalPath": canonical }))?;
        let grant: BackendDestinationGrant = serde_json::from_value(value).map_err(|error| format!("decode destination grant: {error}"))?;
        let mut approved = state.approved_destinations.lock().map_err(|_| "destination grant lock unavailable")?;
        approved.retain(|item| item.expires > Instant::now());
        approved.push(ApprovedDestination { root: canonical, expires: Instant::now() + Duration::from_secs(10 * 60) });
        Ok(DestinationGrantResult { status: "granted".into(), destination_grant_id: Some(grant.id), expires_at: Some(grant.expires_at) })
    }
}

fn ide_executables(ide: &str) -> Vec<PathBuf> {
    match ide {
        "vscode" => vec![PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"), PathBuf::from("/usr/local/bin/code"), PathBuf::from("/opt/homebrew/bin/code")],
        "cursor" => vec![PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/cursor"), PathBuf::from("/usr/local/bin/cursor"), PathBuf::from("/opt/homebrew/bin/cursor")],
        "zed" => vec![PathBuf::from("/Applications/Zed.app/Contents/MacOS/cli"), PathBuf::from("/usr/local/bin/zed"), PathBuf::from("/opt/homebrew/bin/zed")],
        _ => Vec::new(),
    }
}

#[tauri::command]
fn open_export_in_ide(exported_path: String, ide: Option<String>, state: State<'_, ServerState>) -> Result<IdeLaunchResult, String> {
    let canonical = std::fs::canonicalize(&exported_path).map_err(|error| format!("canonicalize exported directory: {error}"))?;
    if !canonical.is_dir() || !canonical.join("mypath/export-manifest.json").is_file() || !canonical.join("package.json").is_file() { return Err("Exported path is not a verified MyPath project directory".into()); }
    let mut approved = state.approved_destinations.lock().map_err(|_| "destination grant lock unavailable")?;
    approved.retain(|item| item.expires > Instant::now());
    if !approved.iter().any(|item| path_is_inside(&item.root, &canonical)) { return Err("Exported path is outside a native-approved destination".into()); }
    drop(approved);
    let requested = ide.unwrap_or_else(|| "auto".into());
    let kinds: Vec<&str> = if requested == "auto" { vec!["vscode", "cursor", "zed"] } else if ["vscode", "cursor", "zed"].contains(&requested.as_str()) { vec![requested.as_str()] } else { return Err("IDE is not in the known executable allowlist".into()); };
    let executable = kinds.into_iter().flat_map(ide_executables).find_map(|candidate| {
        if !candidate.is_file() { return None; }
        let canonical_executable = std::fs::canonicalize(&candidate).ok()?;
        // Symlinks are permitted only when they resolve to another explicitly known path.
        let known = ["vscode", "cursor", "zed"].into_iter().flat_map(ide_executables).filter_map(|path| std::fs::canonicalize(path).ok()).any(|path| path == canonical_executable);
        if known { Some(canonical_executable) } else { None }
    });
    let Some(executable) = executable else { return Ok(IdeLaunchResult { exported_path: canonical.display().to_string(), launch_status: "unavailable".into() }); };
    let status = match Command::new(executable).arg(&canonical).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() { Ok(_) => "launched", Err(_) => "failed" };
    Ok(IdeLaunchResult { exported_path: canonical.display().to_string(), launch_status: status.into() })
}

fn main() {
    #[cfg(unix)]
    install_signal_handlers();

    let instance_nonce = instance_nonce().unwrap_or_else(|e| {
        eprintln!("MyPath failed to initialize: {e}");
        std::process::exit(1);
    });
    let state = ServerState {
        child: Mutex::new(None),
        instance_nonce: instance_nonce.clone(),
        approved_destinations: Mutex::new(Vec::new()),
    };

    if let Err(e) = start_server(&state, &instance_nonce) {
        eprintln!("MyPath failed to start: {e}");
        std::process::exit(1);
    }
    if let Err(e) = write_desktop_smoke_descriptor(&instance_nonce) {
        eprintln!("MyPath failed to start: {e}");
        stop_owned_server();
        std::process::exit(1);
    }

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![pick_export_destination, open_export_in_ide])
        .setup(move |app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("MyPath");
                // The nonce binds session bootstrap to the desktop-started backend instance.
                let url = format!(
                    "http://127.0.0.1:{}/?instanceNonce={}",
                    port(), instance_nonce
                );
                match url.parse() {
                    Ok(parsed) => {
                        if let Err(e) = w.navigate(parsed) {
                            eprintln!("navigate failed: {e}");
                            let _ = w.eval(&format!(
                                "window.location.replace({})",
                                serde_json::to_string(&url).unwrap()
                            ));
                        }
                    }
                    Err(e) => eprintln!("bad url: {e}"),
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building MyPath")
        .run(|_app_handle, event| {
            if matches!(
                event,
                RunEvent::Exit | RunEvent::ExitRequested { .. }
            ) {
                stop_owned_server();
            }
        });

    // normal return path
    stop_owned_server();
}
