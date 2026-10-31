//! Phase 0 probe. Answers, on a real Windows machine, whether the Drag Action Wheel is feasible:
//!   1. does the app stay alive with its main window hidden (tray)?
//!   2. does a global shortcut arrive while a file is being dragged in Explorer?
//!   3. can a pre-created overlay be shown under the cursor without cancelling the drag or taking focus?
//!   4. does that overlay receive the in-progress drag (paths at enter, position while moving, paths on drop)?
//!   5. do Escape and "drop outside" end things cleanly?
//! Everything it observes is written, with timestamps, to `%TEMP%\dragwheel-probe.log` and to the main window.
//! It uses the same OS drop mechanism the product would (wry's IDropTarget on the overlay's WebView2), never HTML5 drag events.

use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewEvent, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const OVERLAY: &str = "overlay";
const OVERLAY_LOGICAL: f64 = 420.0;
const DEFAULT_SHORTCUT: &str = "Ctrl+Shift+Space";
/// The overlay hides itself this long after the mouse button is released (the drop event arrives first).
const AFTER_RELEASE: Duration = Duration::from_millis(900);
const MAX_VISIBLE: Duration = Duration::from_secs(20);

struct Probe {
    t0: Instant,
    file: Mutex<Option<File>>,
    /// Bumped on every show and hide so an old poller thread knows it is stale.
    generation: AtomicU64,
    shortcut: Mutex<Option<Shortcut>>,
}

fn log(app: &AppHandle, msg: impl AsRef<str>) {
    let p = app.state::<Arc<Probe>>();
    let line = format!("[{:>8.1} ms] {}", p.t0.elapsed().as_secs_f64() * 1000.0, msg.as_ref());
    if let Some(f) = p.file.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{line}");
    }
    let _ = app.emit_to("main", "probe-log", line);
}

#[cfg(windows)]
mod native {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    pub fn escape_down() -> bool {
        unsafe { GetAsyncKeyState(VK_ESCAPE as i32) < 0 }
    }
    pub fn left_button_down() -> bool {
        unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 }
    }
    pub fn foreground() -> isize {
        unsafe { GetForegroundWindow() as isize }
    }
}

#[cfg(not(windows))]
mod native {
    // The probe only means something on Windows; these keep it compiling elsewhere.
    pub fn escape_down() -> bool {
        false
    }
    pub fn left_button_down() -> bool {
        false
    }
    pub fn foreground() -> isize {
        0
    }
}

fn hide_overlay(app: &AppHandle, reason: &str) {
    let probe = app.state::<Arc<Probe>>();
    probe.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(OVERLAY) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            log(app, format!("overlay hidden ({reason})"));
            let _ = app.emit_to(OVERLAY, "overlay-reset", ());
        }
    }
}

/// Place the overlay centred on the cursor, inside the work area of the monitor the cursor is on, and show it
/// without activating it. Every number that matters is logged so multi-monitor / DPI behaviour can be judged.
fn show_overlay(app: &AppHandle) {
    let Some(w) = app.get_webview_window(OVERLAY) else {
        log(app, "ERROR overlay window does not exist");
        return;
    };
    let probe = app.state::<Arc<Probe>>().inner().clone();
    let lbutton = native::left_button_down();
    let fg_before = native::foreground();
    let cursor = match app.cursor_position() {
        Ok(c) => c,
        Err(e) => {
            log(app, format!("ERROR cursor_position: {e}"));
            return;
        }
    };
    let monitor = app.monitor_from_point(cursor.x, cursor.y).ok().flatten();
    let (scale, work, name) = match &monitor {
        Some(m) => (m.scale_factor(), *m.work_area(), m.name().cloned().unwrap_or_default()),
        None => (1.0, tauri::PhysicalRect { position: PhysicalPosition::new(0, 0), size: PhysicalSize::new(1920, 1080) }, "(no monitor found)".into()),
    };
    let side = (OVERLAY_LOGICAL * scale).round() as i32;
    let (wx, wy, ww, wh) = (work.position.x, work.position.y, work.size.width as i32, work.size.height as i32);
    let x = ((cursor.x as i32) - side / 2).clamp(wx, (wx + ww - side).max(wx));
    let y = ((cursor.y as i32) - side / 2).clamp(wy, (wy + wh - side).max(wy));
    log(
        app,
        format!(
            "SHORTCUT. left_button_down={lbutton} cursor=({:.0},{:.0}) monitor=\"{name}\" scale={scale} work_area=({wx},{wy} {ww}x{wh}) -> overlay ({x},{y}) {side}x{side} px",
            cursor.x, cursor.y
        ),
    );

    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.set_size(PhysicalSize::new(side as u32, side as u32));
    let _ = w.set_always_on_top(true);
    if let Err(e) = w.show() {
        log(app, format!("ERROR show: {e}"));
        return;
    }
    // Moving a window between monitors with different scaling can make Windows resize it; set it once more.
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.set_size(PhysicalSize::new(side as u32, side as u32));
    let gen = probe.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (pos, size) = (w.outer_position().ok(), w.outer_size().ok());
    log(
        app,
        format!(
            "overlay shown: outer_position={:?} outer_size={:?} scale_now={:?} focused={:?} foreground_changed={}",
            pos.map(|p| (p.x, p.y)),
            size.map(|s| (s.width, s.height)),
            w.scale_factor().ok(),
            w.is_focused().ok(),
            native::foreground() != fg_before
        ),
    );

    // While the overlay is up: Escape and "button released" end it. Polling the key/button state does not hook the
    // keyboard or mouse and does not register any extra shortcut.
    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut released_at: Option<Instant> = None;
        let mut saw_down = lbutton;
        let mut esc_was_down = native::escape_down();
        loop {
            std::thread::sleep(Duration::from_millis(20));
            if probe.generation.load(Ordering::SeqCst) != gen {
                return; // hidden by something else (a drop, a newer show)
            }
            let esc = native::escape_down();
            if esc && !esc_was_down {
                log(&app, "ESC pressed");
                hide_overlay(&app, "escape");
                return;
            }
            esc_was_down = esc;
            let down = native::left_button_down();
            saw_down |= down;
            if saw_down && !down {
                let t = *released_at.get_or_insert_with(Instant::now);
                if t.elapsed() > AFTER_RELEASE {
                    hide_overlay(&app, "mouse button released with no drop on an action");
                    return;
                }
            }
            if started.elapsed() > MAX_VISIBLE {
                hide_overlay(&app, "timed out");
                return;
            }
        }
    });
}

#[tauri::command]
fn probe_log(app: AppHandle, message: String) {
    log(&app, message);
}

#[tauri::command]
fn overlay_hide(app: AppHandle, reason: String) {
    hide_overlay(&app, &reason);
}

#[derive(Serialize)]
struct PathReport {
    path: String,
    chars: usize,
    exists: bool,
    is_dir: bool,
    is_symlink: bool,
    non_ascii: bool,
    size: u64,
}

/// What Rust can say about a dropped path. The product validates every path like this, again, in Rust.
#[tauri::command]
fn probe_drop(app: AppHandle, paths: Vec<String>, action: String) -> Vec<PathReport> {
    let reports: Vec<PathReport> = paths
        .iter()
        .map(|p| {
            let meta = std::fs::symlink_metadata(p).ok();
            PathReport {
                path: p.clone(),
                chars: p.chars().count(),
                exists: meta.is_some(),
                is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
                is_symlink: meta.as_ref().is_some_and(|m| m.file_type().is_symlink()),
                non_ascii: !p.is_ascii(),
                size: meta.map(|m| m.len()).unwrap_or(0),
            }
        })
        .collect();
    log(&app, format!("DROP on \"{action}\": {} path(s)", reports.len()));
    for r in &reports {
        log(&app, format!("   {} | exists={} dir={} symlink={} non_ascii={} size={}", r.path, r.exists, r.is_dir, r.is_symlink, r.non_ascii, r.size));
    }
    hide_overlay(&app, "drop on an action");
    reports
}

fn register(app: &AppHandle, spec: &str) -> Result<(), String> {
    let shortcut: Shortcut = spec.parse().map_err(|e| format!("“{spec}” isn't a valid shortcut ({e})"))?;
    let gs = app.global_shortcut();
    if gs.is_registered(shortcut) {
        return Err(format!("“{spec}” is already registered"));
    }
    gs.on_shortcut(shortcut, |app, _s, event| {
        if event.state == ShortcutState::Pressed {
            show_overlay(app);
        }
    })
    // Windows refuses a combination another program already owns; that is the "conflict" case.
    .map_err(|e| format!("Couldn't register “{spec}”: {e}. Another program may already use it."))?;
    let probe = app.state::<Arc<Probe>>();
    let old = probe.shortcut.lock().unwrap().replace(shortcut);
    if let Some(old) = old {
        let _ = gs.unregister(old);
    }
    Ok(())
}

#[tauri::command]
fn set_shortcut(app: AppHandle, spec: String) -> Result<String, String> {
    match register(&app, spec.trim()) {
        Ok(()) => {
            log(&app, format!("shortcut registered: {}", spec.trim()));
            Ok(format!("Registered {}", spec.trim()))
        }
        Err(e) => {
            log(&app, format!("shortcut NOT registered: {e}"));
            Err(e)
        }
    }
}

#[tauri::command]
fn current_shortcut(app: AppHandle) -> Option<String> {
    app.state::<Arc<Probe>>().shortcut.lock().unwrap().map(|s| s.to_string())
}

fn main() {
    let path = std::env::temp_dir().join("dragwheel-probe.log");
    let probe = Arc::new(Probe { t0: Instant::now(), file: Mutex::new(File::create(&path).ok()), generation: AtomicU64::new(0), shortcut: Mutex::new(None) });

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(probe)
        .invoke_handler(tauri::generate_handler![probe_log, overlay_hide, probe_drop, set_shortcut, current_shortcut])
        .setup(move |app| {
            let h = app.handle().clone();
            log(&h, format!("started; log file: {}", path.display()));

            // Tray: proves background operation and gives the explicit Exit.
            let show = MenuItem::with_id(app, "show", "Open probe window", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &exit])?;
            // PROBE_NO_TRAY=1 skips the tray (only for smoke-testing on systems without tray support).
            if std::env::var_os("PROBE_NO_TRAY").is_none() {
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("window icon"))
                .tooltip("Drag wheel probe")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "exit" => {
                        log(app, "EXIT from tray: unregistering shortcut, closing windows, exiting");
                        let _ = app.global_shortcut().unregister_all();
                        if let Some(w) = app.get_webview_window(OVERLAY) {
                            let _ = w.close();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            }

            // Closing the main window hides it; the process keeps running (background mode).
            if let Some(main) = app.get_webview_window("main") {
                let h2 = h.clone();
                main.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        if let Some(m) = h2.get_webview_window("main") {
                            let _ = m.hide();
                        }
                        log(&h2, "main window hidden to tray (process still running)");
                    }
                });
            }

            // The drop as Rust sees it. The product takes dropped paths from here, never from the page, so a web
            // page can't invent a path. (The overlay page also logs what it sees, to compare the two.)
            if let Some(ov) = app.get_webview_window(OVERLAY) {
                let h3 = h.clone();
                let overs = std::sync::atomic::AtomicU32::new(0);
                ov.on_webview_event(move |e| {
                    if let WebviewEvent::DragDrop(d) = e {
                        match d {
                            DragDropEvent::Enter { paths, position } => {
                                overs.store(0, Ordering::SeqCst);
                                log(&h3, format!("RUST drag ENTER {} path(s) at ({:.0},{:.0}): {:?}", paths.len(), position.x, position.y, paths));
                            }
                            DragDropEvent::Over { .. } => {
                                overs.fetch_add(1, Ordering::SeqCst);
                            }
                            DragDropEvent::Drop { paths, position } => {
                                log(&h3, format!("RUST drag DROP after {} over events at ({:.0},{:.0}): {:?}", overs.load(Ordering::SeqCst), position.x, position.y, paths));
                            }
                            DragDropEvent::Leave => log(&h3, format!("RUST drag LEAVE after {} over events", overs.load(Ordering::SeqCst))),
                            _ => {}
                        }
                    }
                });
            }

            let spec = std::env::var("PROBE_SHORTCUT").unwrap_or_else(|_| DEFAULT_SHORTCUT.into());
            match register(&h, &spec) {
                Ok(()) => log(&h, format!("shortcut registered: {spec}")),
                Err(e) => log(&h, format!("shortcut NOT registered: {e}")),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the probe");
}
