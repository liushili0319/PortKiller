mod contracts;
mod platform;
mod port_inventory;
mod termination;

use serde::Serialize;

pub use contracts::{
    AddressFamily, EndpointKey, KillProcessRequest, PortEntry, Protocol, TerminationOutcome,
    TerminationReason, TerminationStatus,
};

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeStatus {
    pub is_windows: bool,
    pub is_admin: bool,
}

#[tauri::command]
async fn get_port_entries() -> Result<Vec<PortEntry>, String> {
    tauri::async_runtime::spawn_blocking(platform::list_port_entries)
        .await
        .map_err(|error| format!("The port scan worker did not complete: {error}"))?
}

#[tauri::command]
fn get_runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        is_windows: cfg!(target_os = "windows"),
        is_admin: platform::is_admin(),
    }
}

#[tauri::command]
async fn kill_port_process(request: KillProcessRequest) -> Result<TerminationOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || platform::terminate_process(request))
        .await
        .map_err(|error| format!("The process-termination worker did not complete: {error}"))
}

#[tauri::command]
fn restart_as_admin() -> Result<(), String> {
    platform::restart_as_admin()
}

#[tauri::command]
fn reveal_process_path(process_path: String) -> Result<(), String> {
    platform::reveal_process_path(&process_path)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_port_entries,
            get_runtime_status,
            kill_port_process,
            restart_as_admin,
            reveal_process_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PortKiller");
}
