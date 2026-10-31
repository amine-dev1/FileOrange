mod client;
mod commands;

use client::ApiClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub api: Arc<ApiClient>,
    pub tickets: Mutex<HashMap<String, Arc<commands::Ticket>>>,
    server: Mutex<Option<file_api::RunningServer>>,
}

pub fn run() {
    // The PDF engine re-runs this executable as its sandboxed worker (see file-core's pdf::host).
    // That must happen before anything touches Tauri, a window or the network.
    if std::env::args().nth(1).as_deref() == Some(file_core::pdf::worker::WORKER_FLAG) {
        std::process::exit(file_core::pdf::worker::main());
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Local mode: the API runs inside this process on 127.0.0.1 with a
            // fresh random token. Job files live in the app cache dir and are
            // wiped when the app exits.
            let data_dir = app.path().app_cache_dir()?.join("jobs");
            let mut cfg = file_api::ApiConfig::local(data_dir);
            cfg.retention = std::time::Duration::from_secs(10 * 60);
            // PDFium ships in the app's resource folder; PDFs open in a separate worker process.
            let mut pdf = file_core::pdf::HostConfig::for_app();
            if let Ok(res) = app.path().resource_dir() {
                pdf = pdf.with_library_dir(res.join("pdfium"));
            }
            // LibreOffice (Word/Excel/PowerPoint to PDF) ships in the same place, in its own folder.
            let mut office = file_core::engine::office::OfficeConfig::for_app();
            if let Ok(res) = app.path().resource_dir() {
                office = office.with_bundled_dir(res.join("libreoffice"));
            }
            let registry = Arc::new(file_core::Registry::bundled_with_office(
                Arc::new(file_core::pdf::PdfHost::new(pdf)),
                Arc::new(file_core::engine::office::OfficeHost::new(office)),
            ));
            // The dry-run review (`review_job`) runs in this process, so it must see the same PDF setup.
            file_core::engine::set_global(registry.clone());
            let server = tauri::async_runtime::block_on(file_api::start_with(cfg, registry))?;
            let api = Arc::new(ApiClient::new(server.base_url(), server.token.clone()));
            app.manage(AppState { api, tickets: Default::default(), server: Mutex::new(Some(server)) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::api_status,
            commands::get_capabilities,
            commands::review_job,
            commands::start_job,
            commands::get_job_status,
            commands::cancel_job,
            commands::download_result,
            commands::reveal_output,
            commands::clear_history,
            commands::list_archive,
            commands::inspect_paths,
            commands::pdf_open,
            commands::pdf_page_image,
            commands::pdf_close,
            commands::read_picture,
        ])
        .build(tauri::generate_context!())
        .expect("error while building File Tool");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Stop the API and delete any job data still on disk.
            let server = handle.state::<AppState>().server.lock().unwrap().take();
            if let Some(server) = server {
                tauri::async_runtime::block_on(server.shutdown());
            }
        }
    });
}
