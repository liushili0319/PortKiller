#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub(crate) use windows::{
    is_admin, list_port_entries, restart_as_admin, reveal_process_path, terminate_process,
};

#[cfg(not(target_os = "windows"))]
pub(crate) fn is_admin() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn list_port_entries() -> Result<Vec<crate::contracts::PortEntry>, String> {
    Err("PortKiller currently supports Windows only.".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process(
    request: crate::contracts::KillProcessRequest,
) -> crate::contracts::TerminationOutcome {
    crate::contracts::TerminationOutcome {
        pid: request.pid,
        status: crate::contracts::TerminationStatus::Failed,
        reason: crate::contracts::TerminationReason::UnsupportedPlatform,
        message: "Process termination is only implemented on Windows.".to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn restart_as_admin() -> Result<(), String> {
    Err("Administrator restart is only implemented on Windows.".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn reveal_process_path(_process_path: &str) -> Result<(), String> {
    Err("Opening process directories is only implemented on Windows.".to_string())
}
