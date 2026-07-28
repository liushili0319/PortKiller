use std::ffi::{c_void, OsStr};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::contracts::{KillProcessRequest, PortEntry, TerminationOutcome};
use crate::port_inventory::{self, ProcessMetadata, ProcessMetadataSource};
use crate::termination::{self, ProcessIdentity, SystemError, TerminationSystem, WaitObservation};

const SYNCHRONIZE_PROCESS: u32 = 0x0010_0000;
const PROCESS_PATH_CAPACITY: usize = 32_768;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveProcessIdentity {
    pub(crate) creation_time: u64,
    pub(crate) process_name: String,
    pub(crate) process_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProcessOpenError {
    AlreadyExited,
    AccessDenied,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProcessQueryError {
    AccessDenied,
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProcessWaitResult {
    Signaled,
    Timeout,
}

pub(crate) struct WindowsProcessHandle {
    raw: HANDLE,
    pid: u32,
}

impl WindowsProcessHandle {
    pub(crate) fn open_for_termination(pid: u32) -> Result<Self, ProcessOpenError> {
        Self::open(
            pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE_PROCESS,
        )
    }

    fn open_for_inspection(pid: u32) -> Result<Self, ProcessOpenError> {
        Self::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    }

    fn open(pid: u32, access: u32) -> Result<Self, ProcessOpenError> {
        // SAFETY: OpenProcess accepts the requested access mask and scalar PID; a
        // non-zero returned handle is owned by this RAII value and closed in Drop.
        let raw = unsafe { OpenProcess(access, 0, pid) };

        if raw != 0 {
            return Ok(Self { raw, pid });
        }

        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(code) if code == ERROR_INVALID_PARAMETER as i32 => {
                Err(ProcessOpenError::AlreadyExited)
            }
            Some(code) if code == ERROR_ACCESS_DENIED as i32 => Err(ProcessOpenError::AccessDenied),
            _ => Err(ProcessOpenError::Failed(format!(
                "Unable to open PID {pid}: {error}"
            ))),
        }
    }

    pub(crate) fn query_identity(&self) -> Result<LiveProcessIdentity, ProcessQueryError> {
        let mut creation_time = empty_filetime();
        let mut exit_time = empty_filetime();
        let mut kernel_time = empty_filetime();
        let mut user_time = empty_filetime();

        // SAFETY: all FILETIME pointers refer to initialized, writable values and
        // self.raw remains valid for the duration of the call.
        if unsafe {
            GetProcessTimes(
                self.raw,
                &mut creation_time,
                &mut exit_time,
                &mut kernel_time,
                &mut user_time,
            )
        } == 0
        {
            return Err(self.query_error("query creation time"));
        }

        let creation_time = filetime_value(creation_time);
        if creation_time == 0 {
            return Err(ProcessQueryError::Failed(format!(
                "PID {} returned an invalid zero creation time.",
                self.pid
            )));
        }

        let mut path_buffer = vec![0u16; PROCESS_PATH_CAPACITY];
        let mut path_length = path_buffer.len() as u32;

        // SAFETY: path_buffer is writable for path_length UTF-16 code units and
        // self.raw remains owned by this value.
        if unsafe {
            QueryFullProcessImageNameW(self.raw, 0, path_buffer.as_mut_ptr(), &mut path_length)
        } == 0
            || path_length == 0
        {
            return Err(self.query_error("query executable path"));
        }

        let process_path = String::from_utf16_lossy(&path_buffer[..path_length as usize]);
        let process_name = process_path
            .rsplit(['\\', '/'])
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or(&process_path)
            .to_string();

        Ok(LiveProcessIdentity {
            creation_time,
            process_name,
            process_path,
        })
    }

    pub(crate) fn wait(&self, timeout_ms: u32) -> Result<ProcessWaitResult, String> {
        // SAFETY: self.raw is a live process handle with SYNCHRONIZE access for
        // termination handles; inspection handles do not call this method.
        let result = unsafe { WaitForSingleObject(self.raw, timeout_ms) };
        match result {
            WAIT_OBJECT_0 => Ok(ProcessWaitResult::Signaled),
            WAIT_TIMEOUT => Ok(ProcessWaitResult::Timeout),
            WAIT_FAILED => Err(format!(
                "Unable to wait for PID {}: {}",
                self.pid,
                std::io::Error::last_os_error()
            )),
            other => Err(format!(
                "Unable to wait for PID {}: unexpected wait result {other}.",
                self.pid
            )),
        }
    }

    pub(crate) fn terminate(&self) -> Result<(), ProcessQueryError> {
        // SAFETY: self.raw is retained from validation and was opened with
        // PROCESS_TERMINATE; no second PID lookup occurs here.
        if unsafe { TerminateProcess(self.raw, 1) } != 0 {
            return Ok(());
        }

        Err(self.query_error("terminate"))
    }

    fn query_error(&self, operation: &str) -> ProcessQueryError {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
            ProcessQueryError::AccessDenied
        } else {
            ProcessQueryError::Failed(format!(
                "Unable to {operation} for PID {}: {error}",
                self.pid
            ))
        }
    }
}

impl Drop for WindowsProcessHandle {
    fn drop(&mut self) {
        // SAFETY: raw is a non-zero handle uniquely owned by this value.
        unsafe {
            CloseHandle(self.raw);
        }
    }
}

fn inspect_process(pid: u32) -> Option<LiveProcessIdentity> {
    let handle = WindowsProcessHandle::open_for_inspection(pid).ok()?;
    handle.query_identity().ok()
}

struct WindowsMetadataSource;

impl ProcessMetadataSource for WindowsMetadataSource {
    fn process_metadata(&mut self, pid: u32) -> Option<ProcessMetadata> {
        inspect_process(pid).map(|identity| ProcessMetadata {
            creation_time: identity.creation_time,
            process_name: identity.process_name,
            process_path: identity.process_path,
        })
    }
}

struct WindowsTerminationSystem;

impl TerminationSystem for WindowsTerminationSystem {
    type Handle = WindowsProcessHandle;

    fn open_process(&mut self, pid: u32) -> Result<Self::Handle, SystemError> {
        WindowsProcessHandle::open_for_termination(pid).map_err(|error| match error {
            ProcessOpenError::AlreadyExited => {
                SystemError::already_exited(format!("PID {pid} no longer exists."))
            }
            ProcessOpenError::AccessDenied => {
                SystemError::access_denied(format!("OpenProcess denied access to PID {pid}."))
            }
            ProcessOpenError::Failed(message) => SystemError::other(message),
        })
    }

    fn process_identity(&mut self, handle: &Self::Handle) -> Result<ProcessIdentity, SystemError> {
        handle
            .query_identity()
            .map(|identity| ProcessIdentity {
                instance_id: identity.creation_time,
                executable_name: identity.process_name,
            })
            .map_err(map_query_error)
    }

    fn wait_process(&mut self, handle: &Self::Handle, timeout_ms: u32) -> WaitObservation {
        match handle.wait(timeout_ms) {
            Ok(ProcessWaitResult::Signaled) => WaitObservation::Signaled,
            Ok(ProcessWaitResult::Timeout) => WaitObservation::TimedOut,
            Err(message) => WaitObservation::Failed(SystemError::other(message)),
        }
    }

    fn owns_endpoint(
        &mut self,
        endpoint: &crate::contracts::EndpointKey,
        pid: u32,
    ) -> Result<bool, SystemError> {
        port_inventory::endpoint_owned_by_pid(endpoint, pid).map_err(SystemError::other)
    }

    fn terminate_process(&mut self, handle: &Self::Handle) -> Result<(), SystemError> {
        handle.terminate().map_err(map_query_error)
    }
}

fn map_query_error(error: ProcessQueryError) -> SystemError {
    match error {
        ProcessQueryError::AccessDenied => SystemError::access_denied("Access denied by Windows."),
        ProcessQueryError::Failed(message) => SystemError::other(message),
    }
}

pub(crate) fn list_port_entries() -> Result<Vec<PortEntry>, String> {
    port_inventory::list_port_entries(&mut WindowsMetadataSource)
}

pub(crate) fn terminate_process(request: KillProcessRequest) -> TerminationOutcome {
    termination::terminate_verified(request, &mut WindowsTerminationSystem)
}

pub(crate) fn is_admin() -> bool {
    // SAFETY: token is initialized by OpenProcessToken on success and closed on
    // every path after acquisition; the elevation buffer has the declared size.
    unsafe {
        let mut token: HANDLE = 0;
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned_size = 0;
        let success = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut c_void,
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned_size,
        );
        CloseHandle(token);

        success != 0 && elevation.TokenIsElevated != 0
    }
}

pub(crate) fn restart_as_admin() -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Unable to locate current executable: {error}"))?;
    let operation = wide_null("runas");
    let file = wide_null(&current_exe.to_string_lossy());

    // SAFETY: all strings are null-terminated and live through the call. Null
    // parameters select the default working directory and no arguments.
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    if result as isize <= 32 {
        return Err(format!(
            "Unable to restart as administrator: ShellExecuteW returned {result:?}."
        ));
    }

    std::process::exit(0);
}

pub(crate) fn reveal_process_path(process_path: &str) -> Result<(), String> {
    let trimmed_path = process_path.trim();
    if trimmed_path.is_empty() {
        return Err("Process path is empty.".to_string());
    }

    let directory = Path::new(trimmed_path)
        .parent()
        .ok_or_else(|| "Process directory could not be determined.".to_string())?;

    std::process::Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|error| format!("Unable to open process directory: {error}"))?;

    Ok(())
}

fn filetime_value(filetime: FILETIME) -> u64 {
    ((filetime.dwHighDateTime as u64) << 32) | filetime.dwLowDateTime as u64
}

fn empty_filetime() -> FILETIME {
    FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain([0]).collect()
}

#[cfg(test)]
mod tests {
    use super::{filetime_value, WindowsProcessHandle};
    use windows_sys::Win32::Foundation::FILETIME;

    #[test]
    fn combines_filetime_halves_without_precision_loss() {
        assert_eq!(
            filetime_value(FILETIME {
                dwLowDateTime: 0x89ab_cdef,
                dwHighDateTime: 0x0123_4567,
            }),
            0x0123_4567_89ab_cdef,
        );
    }

    #[test]
    fn inspects_the_current_process_through_one_handle() {
        let handle = WindowsProcessHandle::open_for_inspection(std::process::id()).unwrap();
        let identity = handle.query_identity().unwrap();

        assert_ne!(identity.creation_time, 0);
        assert!(!identity.process_name.trim().is_empty());
        assert!(!identity.process_path.trim().is_empty());
    }
}
