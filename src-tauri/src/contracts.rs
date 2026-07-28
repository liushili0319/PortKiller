use serde::{Deserialize, Serialize};
use std::net::IpAddr;

pub(crate) const PROCESS_INSTANCE_ID_HEX_LEN: usize = 16;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub enum AddressFamily {
    #[serde(rename = "ipv4")]
    Ipv4,
    #[serde(rename = "ipv6")]
    Ipv6,
}

impl AddressFamily {
    fn matches(self, address: IpAddr) -> bool {
        matches!(
            (self, address),
            (Self::Ipv4, IpAddr::V4(_)) | (Self::Ipv6, IpAddr::V6(_))
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Protocol {
    #[serde(rename = "TCP")]
    Tcp,
    #[serde(rename = "UDP")]
    Udp,
}

/// Stable, normalized socket identity used for live ownership revalidation.
///
/// IP strings contain only canonical address text. Brackets, IPv6 scope suffixes,
/// and ports belong in the display fields on [`PortEntry`], not in this key.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct EndpointKey {
    pub address_family: AddressFamily,
    pub protocol: Protocol,
    pub local_ip: String,
    pub local_scope_id: u32,
    pub local_port: u16,
    pub remote_ip: Option<String>,
    pub remote_scope_id: Option<u32>,
    pub remote_port: Option<u16>,
}

impl EndpointKey {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let local_ip = self
            .local_ip
            .parse::<IpAddr>()
            .map_err(|_| "local_ip is not a valid unadorned IP address")?;

        if !self.address_family.matches(local_ip) {
            return Err("local_ip does not match address_family");
        }

        if self.local_port == 0 {
            return Err("local_port must be between 1 and 65535");
        }

        if local_ip.to_string() != self.local_ip {
            return Err("local_ip must use canonical address spelling");
        }

        if self.address_family == AddressFamily::Ipv4 && self.local_scope_id != 0 {
            return Err("IPv4 local_scope_id must be zero");
        }

        match self.protocol {
            Protocol::Udp => {
                if self.remote_ip.is_some()
                    || self.remote_scope_id.is_some()
                    || self.remote_port.is_some()
                {
                    return Err("UDP endpoint must not contain remote fields");
                }
            }
            Protocol::Tcp => {
                let (Some(remote_ip), Some(remote_scope_id), Some(_remote_port)) = (
                    self.remote_ip.as_deref(),
                    self.remote_scope_id,
                    self.remote_port,
                ) else {
                    return Err("TCP endpoint must contain all remote fields");
                };

                let remote_ip_text = remote_ip;
                let remote_ip = remote_ip_text
                    .parse::<IpAddr>()
                    .map_err(|_| "remote_ip is not a valid unadorned IP address")?;

                if !self.address_family.matches(remote_ip) {
                    return Err("remote_ip does not match address_family");
                }

                if remote_ip.to_string() != remote_ip_text {
                    return Err("remote_ip must use canonical address spelling");
                }

                if self.address_family == AddressFamily::Ipv4 && remote_scope_id != 0 {
                    return Err("IPv4 remote_scope_id must be zero");
                }
            }
        }

        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PortEntry {
    // Compatibility display fields consumed by the existing frontend.
    pub port: u16,
    pub protocol: Protocol,
    pub state: String,
    pub local_address: String,
    pub remote_address: String,
    pub pid: u32,
    pub process_name: String,
    pub process_path: String,

    // Additive fields used by the verified termination flow.
    pub entry_id: String,
    pub endpoint: EndpointKey,
    pub process_instance_id: Option<String>,
    pub can_terminate: bool,
    pub protection_reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KillProcessRequest {
    pub entry_id: String,
    pub pid: u32,
    pub endpoint: EndpointKey,
    pub process_instance_id: Option<String>,
}

/// Builds the backend-issued stable row identifier. Rendering code treats this
/// value as opaque; the termination path recomputes it from the structured
/// request to reject internally inconsistent payloads.
pub(crate) fn endpoint_entry_id(
    endpoint: &EndpointKey,
    pid: u32,
    process_instance_id: Option<&str>,
) -> String {
    let family = match endpoint.address_family {
        AddressFamily::Ipv4 => "4",
        AddressFamily::Ipv6 => "6",
    };
    let protocol = match endpoint.protocol {
        Protocol::Tcp => "T",
        Protocol::Udp => "U",
    };
    let remote_ip = endpoint.remote_ip.as_deref().unwrap_or("-");
    let remote_scope_id = endpoint
        .remote_scope_id
        .map_or_else(|| "-".to_string(), |scope_id| scope_id.to_string());
    let remote_port = endpoint
        .remote_port
        .map_or_else(|| "-".to_string(), |port| port.to_string());

    format!(
        "{family}|{protocol}|{}|{}|{}|{remote_ip}|{remote_scope_id}|{remote_port}|{pid}|{}",
        endpoint.local_ip,
        endpoint.local_scope_id,
        endpoint.local_port,
        process_instance_id.unwrap_or("-"),
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminationStatus {
    Terminated,
    AlreadyExited,
    Rejected,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminationReason {
    Confirmed,
    AlreadyExited,
    ProtectedProcess,
    IdentityUnavailable,
    ProcessInstanceChanged,
    EndpointChanged,
    EndpointVerificationFailed,
    AccessDenied,
    TerminationFailed,
    ConfirmationTimeout,
    WaitFailed,
    InvalidRequest,
    UnsupportedPlatform,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TerminationOutcome {
    pub pid: u32,
    pub status: TerminationStatus,
    pub reason: TerminationReason,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessInstanceIdError {
    InvalidLength,
    InvalidCharacter,
    Zero,
}

/// Encodes a Windows process creation FILETIME without crossing JSON's numeric
/// precision boundary. Callers must not emit a zero FILETIME as a usable ID.
pub(crate) fn encode_process_instance_id(filetime: u64) -> String {
    format!("{filetime:016x}")
}

/// Decodes and validates the exact representation emitted by
/// [`encode_process_instance_id`]. Uppercase or non-fixed-width forms are
/// deliberately rejected so the IPC contract has one canonical spelling.
pub(crate) fn decode_process_instance_id(
    process_instance_id: &str,
) -> Result<u64, ProcessInstanceIdError> {
    if process_instance_id.len() != PROCESS_INSTANCE_ID_HEX_LEN {
        return Err(ProcessInstanceIdError::InvalidLength);
    }

    if !process_instance_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProcessInstanceIdError::InvalidCharacter);
    }

    let value = u64::from_str_radix(process_instance_id, 16)
        .map_err(|_| ProcessInstanceIdError::InvalidCharacter)?;

    if value == 0 {
        return Err(ProcessInstanceIdError::Zero);
    }

    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::value::{Error as ValueError, StrDeserializer};

    fn tcp_v6_endpoint() -> EndpointKey {
        EndpointKey {
            address_family: AddressFamily::Ipv6,
            protocol: Protocol::Tcp,
            local_ip: "fe80::1".to_string(),
            local_scope_id: 12,
            local_port: 443,
            remote_ip: Some("::".to_string()),
            remote_scope_id: Some(0),
            remote_port: Some(0),
        }
    }

    #[test]
    fn process_instance_id_is_fixed_width_lowercase_and_lossless() {
        assert_eq!(encode_process_instance_id(1), "0000000000000001");
        assert_eq!(encode_process_instance_id(0xABCD), "000000000000abcd");

        let above_javascript_safe_integer = 0x01dc_beef_1234_5678;
        let encoded = encode_process_instance_id(above_javascript_safe_integer);

        assert_eq!(encoded, "01dcbeef12345678");
        assert_eq!(
            decode_process_instance_id(&encoded),
            Ok(above_javascript_safe_integer)
        );
    }

    #[test]
    fn process_instance_id_rejects_noncanonical_or_zero_values() {
        assert_eq!(
            decode_process_instance_id("1"),
            Err(ProcessInstanceIdError::InvalidLength)
        );
        assert_eq!(
            decode_process_instance_id("01DCBEEF12345678"),
            Err(ProcessInstanceIdError::InvalidCharacter)
        );
        assert_eq!(
            decode_process_instance_id("01dcbeef1234567z"),
            Err(ProcessInstanceIdError::InvalidCharacter)
        );
        assert_eq!(
            decode_process_instance_id("0000000000000000"),
            Err(ProcessInstanceIdError::Zero)
        );
    }

    #[test]
    fn endpoint_key_equality_includes_every_identity_field() {
        let endpoint = tcp_v6_endpoint();
        assert_eq!(endpoint, endpoint.clone());

        let mut variations = Vec::new();

        let mut changed = endpoint.clone();
        changed.address_family = AddressFamily::Ipv4;
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.protocol = Protocol::Udp;
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.local_ip = "fe80::2".to_string();
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.local_scope_id = 13;
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.local_port = 8443;
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.remote_ip = Some("::1".to_string());
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.remote_scope_id = Some(14);
        variations.push(changed);

        let mut changed = endpoint.clone();
        changed.remote_port = Some(8443);
        variations.push(changed);

        assert!(variations.iter().all(|changed| changed != &endpoint));
    }

    #[test]
    fn endpoint_validation_accepts_normalized_tcp_and_udp_shapes() {
        assert_eq!(tcp_v6_endpoint().validate(), Ok(()));

        let udp_v4 = EndpointKey {
            address_family: AddressFamily::Ipv4,
            protocol: Protocol::Udp,
            local_ip: "127.0.0.1".to_string(),
            local_scope_id: 0,
            local_port: 5353,
            remote_ip: None,
            remote_scope_id: None,
            remote_port: None,
        };

        assert_eq!(udp_v4.validate(), Ok(()));
    }

    #[test]
    fn endpoint_validation_rejects_display_strings_and_inconsistent_shapes() {
        let mut endpoint = tcp_v6_endpoint();
        endpoint.local_ip = "[fe80::1%12]:443".to_string();
        assert!(endpoint.validate().is_err());

        let mut endpoint = tcp_v6_endpoint();
        endpoint.remote_port = None;
        assert!(endpoint.validate().is_err());

        let mut endpoint = tcp_v6_endpoint();
        endpoint.address_family = AddressFamily::Ipv4;
        assert!(endpoint.validate().is_err());

        let mut endpoint = tcp_v6_endpoint();
        endpoint.protocol = Protocol::Udp;
        assert!(endpoint.validate().is_err());

        let mut endpoint = tcp_v6_endpoint();
        endpoint.local_port = 0;
        assert!(endpoint.validate().is_err());

        let mut endpoint = tcp_v6_endpoint();
        endpoint.local_ip = "fe80:0:0:0:0:0:0:1".to_string();
        assert!(endpoint.validate().is_err());
    }

    #[test]
    fn entry_id_covers_endpoint_pid_and_process_instance() {
        let endpoint = tcp_v6_endpoint();
        let base = endpoint_entry_id(&endpoint, 42, Some("01dcbeef12345678"));

        assert_ne!(
            base,
            endpoint_entry_id(&endpoint, 43, Some("01dcbeef12345678"))
        );
        assert_ne!(
            base,
            endpoint_entry_id(&endpoint, 42, Some("01dcbeef12345679"))
        );
        assert_ne!(base, endpoint_entry_id(&endpoint, 42, None));
    }

    #[test]
    fn serialized_enum_names_deserialize_with_the_documented_spelling() {
        let tcp = Protocol::deserialize(StrDeserializer::<ValueError>::new("TCP")).unwrap();
        let ipv6 = AddressFamily::deserialize(StrDeserializer::<ValueError>::new("ipv6")).unwrap();
        let already_exited =
            TerminationStatus::deserialize(StrDeserializer::<ValueError>::new("already_exited"))
                .unwrap();
        let identity_unavailable = TerminationReason::deserialize(
            StrDeserializer::<ValueError>::new("identity_unavailable"),
        )
        .unwrap();

        assert_eq!(tcp, Protocol::Tcp);
        assert_eq!(ipv6, AddressFamily::Ipv6);
        assert_eq!(already_exited, TerminationStatus::AlreadyExited);
        assert_eq!(identity_unavailable, TerminationReason::IdentityUnavailable);
        assert!(Protocol::deserialize(StrDeserializer::<ValueError>::new("tcp")).is_err());
    }
}
