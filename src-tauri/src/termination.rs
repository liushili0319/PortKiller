use crate::contracts::{
    decode_process_instance_id, endpoint_entry_id, EndpointKey, KillProcessRequest,
    TerminationOutcome, TerminationReason, TerminationStatus,
};

const LIVENESS_WAIT_MS: u32 = 0;
pub(crate) const TERMINATION_WAIT_MS: u32 = 5_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProcessIdentity {
    pub(crate) instance_id: u64,
    pub(crate) executable_name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SystemErrorKind {
    AlreadyExited,
    AccessDenied,
    UnsupportedPlatform,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SystemError {
    kind: SystemErrorKind,
    message: String,
}

impl SystemError {
    pub(crate) fn new(kind: SystemErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn already_exited(message: impl Into<String>) -> Self {
        Self::new(SystemErrorKind::AlreadyExited, message)
    }

    pub(crate) fn access_denied(message: impl Into<String>) -> Self {
        Self::new(SystemErrorKind::AccessDenied, message)
    }

    #[cfg(test)]
    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self::new(SystemErrorKind::UnsupportedPlatform, message)
    }

    pub(crate) fn other(message: impl Into<String>) -> Self {
        Self::new(SystemErrorKind::Other, message)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WaitObservation {
    Signaled,
    TimedOut,
    Failed(SystemError),
}

/// Narrow seam around the observations and actions needed for one verified
/// process termination. It intentionally has no process-enumeration method, so
/// the orchestrator cannot broaden a request to same-name or related PIDs.
pub(crate) trait TerminationSystem {
    type Handle;

    fn open_process(&mut self, pid: u32) -> Result<Self::Handle, SystemError>;

    fn process_identity(&mut self, handle: &Self::Handle) -> Result<ProcessIdentity, SystemError>;

    fn wait_process(&mut self, handle: &Self::Handle, timeout_ms: u32) -> WaitObservation;

    fn owns_endpoint(&mut self, endpoint: &EndpointKey, pid: u32) -> Result<bool, SystemError>;

    fn terminate_process(&mut self, handle: &Self::Handle) -> Result<(), SystemError>;
}

/// Verifies and terminates exactly one process instance.
///
/// Expected OS and policy outcomes are returned as data. The caller's command
/// error channel remains available for executor/join and deserialization failures.
pub(crate) fn terminate_verified<S: TerminationSystem>(
    request: KillProcessRequest,
    system: &mut S,
) -> TerminationOutcome {
    let pid = request.pid;

    if let Err(error) = request.endpoint.validate() {
        return outcome(
            pid,
            TerminationStatus::Failed,
            TerminationReason::InvalidRequest,
            format!("The endpoint supplied for PID {pid} is invalid: {error}."),
        );
    }

    let Some(process_instance_id) = request.process_instance_id.as_deref() else {
        return outcome(
            pid,
            TerminationStatus::Rejected,
            TerminationReason::IdentityUnavailable,
            format!(
                "PID {pid} has no verified process identity. Refresh the port list and try again."
            ),
        );
    };

    let expected_instance_id = match decode_process_instance_id(process_instance_id) {
        Ok(instance_id) => instance_id,
        Err(_) => {
            return outcome(
                pid,
                TerminationStatus::Failed,
                TerminationReason::InvalidRequest,
                format!("The process identity supplied for PID {pid} is invalid."),
            );
        }
    };

    if request.entry_id != endpoint_entry_id(&request.endpoint, pid, Some(process_instance_id)) {
        return outcome(
            pid,
            TerminationStatus::Failed,
            TerminationReason::InvalidRequest,
            format!("The endpoint identifier supplied for PID {pid} is inconsistent."),
        );
    }

    if is_protected_process(pid, "") {
        return protected_outcome(pid);
    }

    let handle = match system.open_process(pid) {
        Ok(handle) => handle,
        Err(error) => return identity_stage_failure(pid, error),
    };

    let live_identity = match system.process_identity(&handle) {
        Ok(identity) => identity,
        Err(error) => return identity_stage_failure(pid, error),
    };

    if live_identity.instance_id == 0 || live_identity.executable_name.trim().is_empty() {
        return outcome(
            pid,
            TerminationStatus::Rejected,
            TerminationReason::IdentityUnavailable,
            format!("The live identity for PID {pid} could not be verified."),
        );
    }

    if live_identity.instance_id != expected_instance_id {
        return outcome(
            pid,
            TerminationStatus::Rejected,
            TerminationReason::ProcessInstanceChanged,
            format!(
                "PID {pid} now belongs to a different process instance. Refresh the port list."
            ),
        );
    }

    if is_protected_process(pid, &live_identity.executable_name) {
        return protected_outcome(pid);
    }

    if let Some(outcome) =
        precondition_wait_outcome(pid, system.wait_process(&handle, LIVENESS_WAIT_MS))
    {
        return outcome;
    }

    match system.owns_endpoint(&request.endpoint, pid) {
        Ok(true) => {}
        Ok(false) => {
            return outcome(
                pid,
                TerminationStatus::Rejected,
                TerminationReason::EndpointChanged,
                format!(
                    "The selected endpoint is no longer owned by PID {pid}. Refresh the port list."
                ),
            );
        }
        Err(error) => return endpoint_failure(pid, error),
    }

    if let Some(outcome) =
        precondition_wait_outcome(pid, system.wait_process(&handle, LIVENESS_WAIT_MS))
    {
        return outcome;
    }

    if let Err(termination_error) = system.terminate_process(&handle) {
        return match system.wait_process(&handle, LIVENESS_WAIT_MS) {
            WaitObservation::Signaled => already_exited_outcome(pid),
            WaitObservation::TimedOut => termination_failure(pid, termination_error),
            WaitObservation::Failed(wait_error) => wait_failure(pid, wait_error),
        };
    }

    match system.wait_process(&handle, TERMINATION_WAIT_MS) {
        WaitObservation::Signaled => outcome(
            pid,
            TerminationStatus::Terminated,
            TerminationReason::Confirmed,
            format!("Terminated PID {pid} and confirmed process exit."),
        ),
        WaitObservation::TimedOut => outcome(
            pid,
            TerminationStatus::Failed,
            TerminationReason::ConfirmationTimeout,
            format!("Timed out waiting for PID {pid} to exit after termination was requested."),
        ),
        WaitObservation::Failed(error) => wait_failure(pid, error),
    }
}

fn outcome(
    pid: u32,
    status: TerminationStatus,
    reason: TerminationReason,
    message: impl Into<String>,
) -> TerminationOutcome {
    TerminationOutcome {
        pid,
        status,
        reason,
        message: message.into(),
    }
}

fn protected_outcome(pid: u32) -> TerminationOutcome {
    outcome(
        pid,
        TerminationStatus::Rejected,
        TerminationReason::ProtectedProcess,
        format!("PID {pid} is a protected Windows process and was not terminated."),
    )
}

fn already_exited_outcome(pid: u32) -> TerminationOutcome {
    outcome(
        pid,
        TerminationStatus::AlreadyExited,
        TerminationReason::AlreadyExited,
        format!("PID {pid} already exited before termination could be confirmed."),
    )
}

fn identity_stage_failure(pid: u32, error: SystemError) -> TerminationOutcome {
    match error.kind {
        SystemErrorKind::AlreadyExited => already_exited_outcome(pid),
        SystemErrorKind::AccessDenied => outcome(
            pid,
            TerminationStatus::Failed,
            TerminationReason::AccessDenied,
            with_detail(
                format!("Unable to inspect PID {pid}: access denied."),
                &error.message,
            ),
        ),
        SystemErrorKind::UnsupportedPlatform => unsupported_outcome(pid, &error.message),
        SystemErrorKind::Other => outcome(
            pid,
            TerminationStatus::Rejected,
            TerminationReason::IdentityUnavailable,
            with_detail(
                format!("The live identity for PID {pid} could not be verified."),
                &error.message,
            ),
        ),
    }
}

fn endpoint_failure(pid: u32, error: SystemError) -> TerminationOutcome {
    if error.kind == SystemErrorKind::UnsupportedPlatform {
        return unsupported_outcome(pid, &error.message);
    }

    outcome(
        pid,
        TerminationStatus::Failed,
        TerminationReason::EndpointVerificationFailed,
        with_detail(
            format!("Unable to verify the selected endpoint for PID {pid}."),
            &error.message,
        ),
    )
}

fn precondition_wait_outcome(pid: u32, observation: WaitObservation) -> Option<TerminationOutcome> {
    match observation {
        WaitObservation::Signaled => Some(already_exited_outcome(pid)),
        WaitObservation::TimedOut => None,
        WaitObservation::Failed(error) => Some(wait_failure(pid, error)),
    }
}

fn termination_failure(pid: u32, error: SystemError) -> TerminationOutcome {
    match error.kind {
        SystemErrorKind::AccessDenied => outcome(
            pid,
            TerminationStatus::Failed,
            TerminationReason::AccessDenied,
            with_detail(
                format!("Unable to terminate PID {pid}: access denied."),
                &error.message,
            ),
        ),
        SystemErrorKind::UnsupportedPlatform => unsupported_outcome(pid, &error.message),
        SystemErrorKind::AlreadyExited | SystemErrorKind::Other => outcome(
            pid,
            TerminationStatus::Failed,
            TerminationReason::TerminationFailed,
            with_detail(format!("Unable to terminate PID {pid}."), &error.message),
        ),
    }
}

fn wait_failure(pid: u32, error: SystemError) -> TerminationOutcome {
    if error.kind == SystemErrorKind::UnsupportedPlatform {
        return unsupported_outcome(pid, &error.message);
    }

    outcome(
        pid,
        TerminationStatus::Failed,
        TerminationReason::WaitFailed,
        with_detail(
            format!("Unable to determine whether PID {pid} exited."),
            &error.message,
        ),
    )
}

fn unsupported_outcome(pid: u32, detail: &str) -> TerminationOutcome {
    outcome(
        pid,
        TerminationStatus::Failed,
        TerminationReason::UnsupportedPlatform,
        with_detail(
            "Process termination is only implemented on Windows.".to_string(),
            detail,
        ),
    )
}

fn with_detail(message: String, detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        message
    } else {
        format!("{message} {detail}")
    }
}

pub(crate) fn is_protected_process(pid: u32, process_name: &str) -> bool {
    const PROTECTED_NAMES: [&str; 9] = [
        "idle",
        "system",
        "registry",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "winlogon.exe",
        "services.exe",
        "lsass.exe",
    ];

    pid == 0
        || pid == 4
        || PROTECTED_NAMES.contains(&process_name.trim().to_ascii_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        encode_process_instance_id, AddressFamily, Protocol, TerminationReason, TerminationStatus,
    };
    use std::collections::{HashMap, VecDeque};

    const TARGET_PID: u32 = 42;
    const TARGET_INSTANCE_ID: u64 = 0x01dc_beef_1234_5678;

    #[derive(Debug)]
    struct FakeSystem {
        processes: HashMap<u32, ProcessIdentity>,
        open_error: Option<SystemError>,
        identity_error: Option<SystemError>,
        endpoint_result: Result<bool, SystemError>,
        terminate_error: Option<SystemError>,
        waits: VecDeque<WaitObservation>,
        opened_pids: Vec<u32>,
        inspected_handles: Vec<u32>,
        endpoint_checks: Vec<(EndpointKey, u32)>,
        terminated_handles: Vec<u32>,
        wait_calls: Vec<(u32, u32)>,
    }

    impl FakeSystem {
        fn successful() -> Self {
            let mut processes = HashMap::new();
            processes.insert(
                TARGET_PID,
                ProcessIdentity {
                    instance_id: TARGET_INSTANCE_ID,
                    executable_name: "node.exe".to_string(),
                },
            );

            Self {
                processes,
                open_error: None,
                identity_error: None,
                endpoint_result: Ok(true),
                terminate_error: None,
                waits: VecDeque::from([
                    WaitObservation::TimedOut,
                    WaitObservation::TimedOut,
                    WaitObservation::Signaled,
                ]),
                opened_pids: Vec::new(),
                inspected_handles: Vec::new(),
                endpoint_checks: Vec::new(),
                terminated_handles: Vec::new(),
                wait_calls: Vec::new(),
            }
        }

        fn assert_no_termination(&self) {
            assert!(self.terminated_handles.is_empty());
        }
    }

    impl TerminationSystem for FakeSystem {
        type Handle = u32;

        fn open_process(&mut self, pid: u32) -> Result<Self::Handle, SystemError> {
            self.opened_pids.push(pid);
            if let Some(error) = self.open_error.clone() {
                Err(error)
            } else {
                Ok(pid)
            }
        }

        fn process_identity(
            &mut self,
            handle: &Self::Handle,
        ) -> Result<ProcessIdentity, SystemError> {
            self.inspected_handles.push(*handle);
            if let Some(error) = self.identity_error.clone() {
                return Err(error);
            }

            self.processes
                .get(handle)
                .cloned()
                .ok_or_else(|| SystemError::already_exited("process disappeared"))
        }

        fn wait_process(&mut self, handle: &Self::Handle, timeout_ms: u32) -> WaitObservation {
            self.wait_calls.push((*handle, timeout_ms));
            self.waits.pop_front().unwrap_or_else(|| {
                WaitObservation::Failed(SystemError::other("unscripted wait observation"))
            })
        }

        fn owns_endpoint(&mut self, endpoint: &EndpointKey, pid: u32) -> Result<bool, SystemError> {
            self.endpoint_checks.push((endpoint.clone(), pid));
            self.endpoint_result.clone()
        }

        fn terminate_process(&mut self, handle: &Self::Handle) -> Result<(), SystemError> {
            self.terminated_handles.push(*handle);
            if let Some(error) = self.terminate_error.clone() {
                Err(error)
            } else {
                Ok(())
            }
        }
    }

    fn endpoint() -> EndpointKey {
        EndpointKey {
            address_family: AddressFamily::Ipv4,
            protocol: Protocol::Tcp,
            local_ip: "127.0.0.1".to_string(),
            local_scope_id: 0,
            local_port: 3000,
            remote_ip: Some("0.0.0.0".to_string()),
            remote_scope_id: Some(0),
            remote_port: Some(0),
        }
    }

    fn request() -> KillProcessRequest {
        let endpoint = endpoint();
        let process_instance_id = encode_process_instance_id(TARGET_INSTANCE_ID);
        KillProcessRequest {
            entry_id: endpoint_entry_id(&endpoint, TARGET_PID, Some(&process_instance_id)),
            pid: TARGET_PID,
            endpoint,
            process_instance_id: Some(process_instance_id),
        }
    }

    fn assert_outcome(
        outcome: &TerminationOutcome,
        status: TerminationStatus,
        reason: TerminationReason,
    ) {
        assert_eq!(outcome.pid, TARGET_PID);
        assert_eq!(outcome.status, status);
        assert_eq!(outcome.reason, reason);
        assert!(!outcome.message.is_empty());
    }

    #[test]
    fn successful_flow_targets_one_pid_and_confirms_exit() {
        let mut system = FakeSystem::successful();

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Terminated,
            TerminationReason::Confirmed,
        );
        assert_eq!(system.opened_pids, vec![TARGET_PID]);
        assert_eq!(system.inspected_handles, vec![TARGET_PID]);
        assert_eq!(system.endpoint_checks, vec![(endpoint(), TARGET_PID)]);
        assert_eq!(system.terminated_handles, vec![TARGET_PID]);
        assert_eq!(
            system.wait_calls,
            vec![
                (TARGET_PID, LIVENESS_WAIT_MS),
                (TARGET_PID, LIVENESS_WAIT_MS),
                (TARGET_PID, TERMINATION_WAIT_MS),
            ]
        );
    }

    #[test]
    fn same_name_processes_cannot_expand_the_requested_pid() {
        let mut system = FakeSystem::successful();
        system.processes.insert(
            7,
            ProcessIdentity {
                instance_id: 7,
                executable_name: "node.exe".to_string(),
            },
        );
        system.processes.insert(
            99,
            ProcessIdentity {
                instance_id: 99,
                executable_name: "node.exe".to_string(),
            },
        );

        let result = terminate_verified(request(), &mut system);

        assert_eq!(result.status, TerminationStatus::Terminated);
        assert_eq!(system.opened_pids, vec![TARGET_PID]);
        assert_eq!(system.terminated_handles, vec![TARGET_PID]);
    }

    #[test]
    fn missing_identity_is_rejected_before_opening_a_process() {
        let mut system = FakeSystem::successful();
        let mut request = request();
        request.process_instance_id = None;

        let result = terminate_verified(request, &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Rejected,
            TerminationReason::IdentityUnavailable,
        );
        assert!(system.opened_pids.is_empty());
        system.assert_no_termination();
    }

    #[test]
    fn malformed_or_zero_identity_is_an_invalid_request() {
        for invalid_identity in [
            "",
            "1",
            "01DCBEEF12345678",
            "01dcbeef1234567z",
            "0000000000000000",
        ] {
            let mut system = FakeSystem::successful();
            let mut request = request();
            request.process_instance_id = Some(invalid_identity.to_string());

            let result = terminate_verified(request, &mut system);

            assert_outcome(
                &result,
                TerminationStatus::Failed,
                TerminationReason::InvalidRequest,
            );
            assert!(system.opened_pids.is_empty());
            system.assert_no_termination();
        }
    }

    #[test]
    fn inconsistent_endpoint_is_an_invalid_request() {
        let mut system = FakeSystem::successful();
        let mut request = request();
        request.endpoint.local_ip = "127.0.0.1:3000".to_string();

        let result = terminate_verified(request, &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::InvalidRequest,
        );
        assert!(system.opened_pids.is_empty());
        system.assert_no_termination();
    }

    #[test]
    fn inconsistent_entry_id_is_an_invalid_request() {
        let mut system = FakeSystem::successful();
        let mut request = request();
        request.entry_id.push_str("|changed");

        let result = terminate_verified(request, &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::InvalidRequest,
        );
        assert!(system.opened_pids.is_empty());
        system.assert_no_termination();
    }

    #[test]
    fn changed_process_instance_is_rejected_without_termination() {
        let mut system = FakeSystem::successful();
        system.processes.get_mut(&TARGET_PID).unwrap().instance_id += 1;

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Rejected,
            TerminationReason::ProcessInstanceChanged,
        );
        system.assert_no_termination();
    }

    #[test]
    fn missing_or_changed_endpoint_is_rejected_without_termination() {
        let mut system = FakeSystem::successful();
        system.endpoint_result = Ok(false);

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Rejected,
            TerminationReason::EndpointChanged,
        );
        assert_eq!(system.endpoint_checks, vec![(endpoint(), TARGET_PID)]);
        system.assert_no_termination();
    }

    #[test]
    fn protected_live_name_is_rejected_without_termination() {
        let mut system = FakeSystem::successful();
        system
            .processes
            .get_mut(&TARGET_PID)
            .unwrap()
            .executable_name = "LSASS.EXE".to_string();

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Rejected,
            TerminationReason::ProtectedProcess,
        );
        system.assert_no_termination();
    }

    #[test]
    fn protected_system_pid_is_rejected_before_opening_a_process() {
        let mut system = FakeSystem::successful();
        let mut request = request();
        request.pid = 4;
        request.entry_id = endpoint_entry_id(
            &request.endpoint,
            request.pid,
            request.process_instance_id.as_deref(),
        );

        let result = terminate_verified(request, &mut system);

        assert_eq!(result.status, TerminationStatus::Rejected);
        assert_eq!(result.reason, TerminationReason::ProtectedProcess);
        assert!(system.opened_pids.is_empty());
        system.assert_no_termination();
    }

    #[test]
    fn already_exited_open_observation_is_truthful() {
        let mut system = FakeSystem::successful();
        system.open_error = Some(SystemError::already_exited("PID no longer exists"));

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::AlreadyExited,
            TerminationReason::AlreadyExited,
        );
        system.assert_no_termination();
    }

    #[test]
    fn identity_failure_is_rejected_without_termination() {
        let mut system = FakeSystem::successful();
        system.identity_error = Some(SystemError::other("GetProcessTimes failed"));

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Rejected,
            TerminationReason::IdentityUnavailable,
        );
        system.assert_no_termination();
    }

    #[test]
    fn access_denied_is_a_failed_outcome() {
        let mut system = FakeSystem::successful();
        system.open_error = Some(SystemError::access_denied(
            "OpenProcess returned access denied",
        ));

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::AccessDenied,
        );
        system.assert_no_termination();
    }

    #[test]
    fn endpoint_read_failure_fails_closed() {
        let mut system = FakeSystem::successful();
        system.endpoint_result = Err(SystemError::other("TCP/IPv4 table read failed"));

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::EndpointVerificationFailed,
        );
        system.assert_no_termination();
    }

    #[test]
    fn exit_during_either_precondition_wait_never_terminates() {
        for waits in [
            VecDeque::from([WaitObservation::Signaled]),
            VecDeque::from([WaitObservation::TimedOut, WaitObservation::Signaled]),
        ] {
            let mut system = FakeSystem::successful();
            system.waits = waits;

            let result = terminate_verified(request(), &mut system);

            assert_outcome(
                &result,
                TerminationStatus::AlreadyExited,
                TerminationReason::AlreadyExited,
            );
            system.assert_no_termination();
        }
    }

    #[test]
    fn wait_failure_during_preconditions_fails_closed() {
        let mut system = FakeSystem::successful();
        system.waits = VecDeque::from([WaitObservation::Failed(SystemError::other(
            "WaitForSingleObject failed",
        ))]);

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::WaitFailed,
        );
        system.assert_no_termination();
    }

    #[test]
    fn natural_exit_that_races_a_failed_terminate_is_already_exited() {
        let mut system = FakeSystem::successful();
        system.terminate_error = Some(SystemError::other("TerminateProcess lost a race"));
        system.waits = VecDeque::from([
            WaitObservation::TimedOut,
            WaitObservation::TimedOut,
            WaitObservation::Signaled,
        ]);

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::AlreadyExited,
            TerminationReason::AlreadyExited,
        );
        assert_eq!(system.terminated_handles, vec![TARGET_PID]);
    }

    #[test]
    fn failed_terminate_while_process_is_live_is_not_success() {
        let mut system = FakeSystem::successful();
        system.terminate_error = Some(SystemError::other("TerminateProcess failed"));
        system.waits = VecDeque::from([
            WaitObservation::TimedOut,
            WaitObservation::TimedOut,
            WaitObservation::TimedOut,
        ]);

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::TerminationFailed,
        );
    }

    #[test]
    fn post_terminate_timeout_is_not_reported_as_terminated() {
        let mut system = FakeSystem::successful();
        system.waits = VecDeque::from([
            WaitObservation::TimedOut,
            WaitObservation::TimedOut,
            WaitObservation::TimedOut,
        ]);

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::ConfirmationTimeout,
        );
        assert_eq!(system.terminated_handles, vec![TARGET_PID]);
    }

    #[test]
    fn post_terminate_wait_failure_is_not_reported_as_terminated() {
        let mut system = FakeSystem::successful();
        system.waits = VecDeque::from([
            WaitObservation::TimedOut,
            WaitObservation::TimedOut,
            WaitObservation::Failed(SystemError::other("wait returned an invalid value")),
        ]);

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::WaitFailed,
        );
        assert_eq!(system.terminated_handles, vec![TARGET_PID]);
    }

    #[test]
    fn unsupported_platform_has_a_structured_failure() {
        let mut system = FakeSystem::successful();
        system.open_error = Some(SystemError::unsupported("not Windows"));

        let result = terminate_verified(request(), &mut system);

        assert_outcome(
            &result,
            TerminationStatus::Failed,
            TerminationReason::UnsupportedPlatform,
        );
        system.assert_no_termination();
    }
}
