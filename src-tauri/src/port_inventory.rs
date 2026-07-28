use std::collections::HashMap;
use std::mem::{offset_of, size_of};
use std::net::{Ipv4Addr, Ipv6Addr};

use crate::contracts::{
    encode_process_instance_id, endpoint_entry_id, AddressFamily, EndpointKey, PortEntry, Protocol,
};
use crate::termination::is_protected_process;

const TABLE_HEADER_BYTES: usize = size_of::<u32>();
const MAX_TABLE_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const MAX_TABLE_READ_ATTEMPTS: usize = 4;

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::ptr::null_mut;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
#[cfg(target_os = "windows")]
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
    MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID,
    MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProcessMetadata {
    pub(crate) creation_time: u64,
    pub(crate) process_name: String,
    pub(crate) process_path: String,
}

pub(crate) trait ProcessMetadataSource {
    fn process_metadata(&mut self, pid: u32) -> Option<ProcessMetadata>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EndpointRecord {
    endpoint: EndpointKey,
    state: String,
    pid: u32,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum TableKind {
    TcpIpv4,
    TcpIpv6,
    UdpIpv4,
    UdpIpv6,
}

impl TableKind {
    const ALL: [Self; 4] = [Self::TcpIpv4, Self::TcpIpv6, Self::UdpIpv4, Self::UdpIpv6];

    const fn label(self) -> &'static str {
        match self {
            Self::TcpIpv4 => "TCP/IPv4",
            Self::TcpIpv6 => "TCP/IPv6",
            Self::UdpIpv4 => "UDP/IPv4",
            Self::UdpIpv6 => "UDP/IPv6",
        }
    }

    const fn for_endpoint(endpoint: &EndpointKey) -> Self {
        match (endpoint.protocol, endpoint.address_family) {
            (Protocol::Tcp, AddressFamily::Ipv4) => Self::TcpIpv4,
            (Protocol::Tcp, AddressFamily::Ipv6) => Self::TcpIpv6,
            (Protocol::Udp, AddressFamily::Ipv4) => Self::UdpIpv4,
            (Protocol::Udp, AddressFamily::Ipv6) => Self::UdpIpv6,
        }
    }
}

trait IpTableSource {
    fn read_records(&mut self, table: TableKind) -> Result<Vec<EndpointRecord>, String>;
}

pub(crate) fn list_port_entries(
    metadata_source: &mut impl ProcessMetadataSource,
) -> Result<Vec<PortEntry>, String> {
    #[cfg(target_os = "windows")]
    {
        let mut table_source = WindowsIpTableSource;
        list_port_entries_with(&mut table_source, metadata_source)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = metadata_source;
        Err("PortKiller currently supports Windows only.".to_string())
    }
}

pub(crate) fn endpoint_owned_by_pid(endpoint: &EndpointKey, pid: u32) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let mut source = WindowsIpTableSource;
        endpoint_owned_by_pid_with(&mut source, endpoint, pid)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (endpoint, pid);
        Err("Endpoint ownership checks are only implemented on Windows.".to_string())
    }
}

fn list_port_entries_with(
    table_source: &mut impl IpTableSource,
    metadata_source: &mut impl ProcessMetadataSource,
) -> Result<Vec<PortEntry>, String> {
    let mut records = Vec::new();
    for table in TableKind::ALL {
        records.extend(table_source.read_records(table).map_err(|error| {
            format!(
                "Unable to complete the port scan at {}: {error}",
                table.label()
            )
        })?);
    }

    sort_records(&mut records);
    Ok(enrich_records(records, metadata_source))
}

fn endpoint_owned_by_pid_with(
    source: &mut impl IpTableSource,
    endpoint: &EndpointKey,
    pid: u32,
) -> Result<bool, String> {
    let table = TableKind::for_endpoint(endpoint);
    let records = source.read_records(table).map_err(|error| {
        format!(
            "Unable to read {} for ownership verification: {error}",
            table.label()
        )
    })?;

    Ok(records
        .iter()
        .any(|record| record.pid == pid && record.endpoint == *endpoint))
}

fn enrich_records(
    records: Vec<EndpointRecord>,
    metadata_source: &mut impl ProcessMetadataSource,
) -> Vec<PortEntry> {
    let mut process_cache: HashMap<u32, Option<ProcessMetadata>> = HashMap::new();

    records
        .into_iter()
        .map(|record| {
            let metadata = process_cache
                .entry(record.pid)
                .or_insert_with(|| metadata_source.process_metadata(record.pid));

            let (process_name, process_path, process_instance_id) = match metadata {
                Some(metadata) => {
                    let process_name = if metadata.process_name.trim().is_empty() {
                        format!("PID {}", record.pid)
                    } else {
                        metadata.process_name.clone()
                    };
                    let process_instance_id = (metadata.creation_time != 0
                        && !metadata.process_name.trim().is_empty())
                    .then(|| encode_process_instance_id(metadata.creation_time));

                    (
                        process_name,
                        metadata.process_path.clone(),
                        process_instance_id,
                    )
                }
                None => (format!("PID {}", record.pid), String::new(), None),
            };

            let port = record.endpoint.local_port;
            let protocol = record.endpoint.protocol;
            let local_address = display_endpoint(
                record.endpoint.address_family,
                &record.endpoint.local_ip,
                record.endpoint.local_scope_id,
                port,
            );
            let remote_address = match (
                record.endpoint.remote_ip.as_deref(),
                record.endpoint.remote_scope_id,
                record.endpoint.remote_port,
            ) {
                (Some(ip), Some(scope_id), Some(remote_port)) => {
                    display_endpoint(record.endpoint.address_family, ip, scope_id, remote_port)
                }
                _ => String::new(),
            };
            let protection_reason = if is_protected_process(record.pid, &process_name) {
                "protected_process"
            } else if process_instance_id.is_none() {
                "identity_unavailable"
            } else {
                ""
            };
            let can_terminate = protection_reason.is_empty();
            let entry_id =
                endpoint_entry_id(&record.endpoint, record.pid, process_instance_id.as_deref());

            PortEntry {
                port,
                protocol,
                state: record.state,
                local_address,
                remote_address,
                pid: record.pid,
                process_name,
                process_path,
                entry_id,
                endpoint: record.endpoint,
                process_instance_id,
                can_terminate,
                protection_reason: protection_reason.to_string(),
            }
        })
        .collect()
}

fn sort_records(records: &mut [EndpointRecord]) {
    records.sort_by(|left, right| {
        left.endpoint
            .local_port
            .cmp(&right.endpoint.local_port)
            .then_with(|| left.endpoint.protocol.cmp(&right.endpoint.protocol))
            .then_with(|| {
                left.endpoint
                    .address_family
                    .cmp(&right.endpoint.address_family)
            })
            .then_with(|| left.endpoint.local_ip.cmp(&right.endpoint.local_ip))
            .then_with(|| {
                left.endpoint
                    .local_scope_id
                    .cmp(&right.endpoint.local_scope_id)
            })
            .then_with(|| left.endpoint.remote_ip.cmp(&right.endpoint.remote_ip))
            .then_with(|| {
                left.endpoint
                    .remote_scope_id
                    .cmp(&right.endpoint.remote_scope_id)
            })
            .then_with(|| left.endpoint.remote_port.cmp(&right.endpoint.remote_port))
            .then_with(|| left.pid.cmp(&right.pid))
            .then_with(|| left.state.cmp(&right.state))
    });
}

fn display_endpoint(family: AddressFamily, ip: &str, scope_id: u32, port: u16) -> String {
    match family {
        AddressFamily::Ipv4 => format!("{ip}:{port}"),
        AddressFamily::Ipv6 if scope_id == 0 => format!("[{ip}]:{port}"),
        AddressFamily::Ipv6 => format!("[{ip}%{scope_id}]:{port}"),
    }
}

#[cfg(target_os = "windows")]
struct WindowsIpTableSource;

#[cfg(target_os = "windows")]
impl IpTableSource for WindowsIpTableSource {
    fn read_records(&mut self, table: TableKind) -> Result<Vec<EndpointRecord>, String> {
        match table {
            TableKind::TcpIpv4 => {
                let bytes = acquire_table(table.label(), |buffer, size| {
                    let pointer = buffer
                        .map(|bytes| bytes.as_mut_ptr().cast::<c_void>())
                        .unwrap_or(null_mut());
                    // SAFETY: pointer is null for the sizing probe or points to a
                    // writable slice whose length was supplied through size.
                    unsafe {
                        GetExtendedTcpTable(
                            pointer,
                            size,
                            0,
                            AF_INET as u32,
                            TCP_TABLE_OWNER_PID_ALL,
                            0,
                        )
                    }
                })?;
                decode_rows::<MIB_TCPROW_OWNER_PID, _>(&bytes, table.label(), tcp_v4_record)
            }
            TableKind::TcpIpv6 => {
                let bytes = acquire_table(table.label(), |buffer, size| {
                    let pointer = buffer
                        .map(|bytes| bytes.as_mut_ptr().cast::<c_void>())
                        .unwrap_or(null_mut());
                    // SAFETY: see the TCP/IPv4 call above.
                    unsafe {
                        GetExtendedTcpTable(
                            pointer,
                            size,
                            0,
                            AF_INET6 as u32,
                            TCP_TABLE_OWNER_PID_ALL,
                            0,
                        )
                    }
                })?;
                decode_rows::<MIB_TCP6ROW_OWNER_PID, _>(&bytes, table.label(), tcp_v6_record)
            }
            TableKind::UdpIpv4 => {
                let bytes = acquire_table(table.label(), |buffer, size| {
                    let pointer = buffer
                        .map(|bytes| bytes.as_mut_ptr().cast::<c_void>())
                        .unwrap_or(null_mut());
                    // SAFETY: pointer is null for the sizing probe or points to a
                    // writable slice whose length was supplied through size.
                    unsafe {
                        GetExtendedUdpTable(
                            pointer,
                            size,
                            0,
                            AF_INET as u32,
                            UDP_TABLE_OWNER_PID,
                            0,
                        )
                    }
                })?;
                decode_rows::<MIB_UDPROW_OWNER_PID, _>(&bytes, table.label(), udp_v4_record)
            }
            TableKind::UdpIpv6 => {
                let bytes = acquire_table(table.label(), |buffer, size| {
                    let pointer = buffer
                        .map(|bytes| bytes.as_mut_ptr().cast::<c_void>())
                        .unwrap_or(null_mut());
                    // SAFETY: see the UDP/IPv4 call above.
                    unsafe {
                        GetExtendedUdpTable(
                            pointer,
                            size,
                            0,
                            AF_INET6 as u32,
                            UDP_TABLE_OWNER_PID,
                            0,
                        )
                    }
                })?;
                decode_rows::<MIB_UDP6ROW_OWNER_PID, _>(&bytes, table.label(), udp_v6_record)
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn acquire_table(
    label: &str,
    mut call: impl FnMut(Option<&mut [u8]>, &mut u32) -> u32,
) -> Result<Vec<u8>, String> {
    let mut required_size = 0u32;
    let probe_status = call(None, &mut required_size);
    if probe_status != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!(
            "{label} sizing probe returned error code {probe_status}."
        ));
    }

    let mut buffer = allocate_table_buffer(label, required_size)?;

    for attempt in 1..=MAX_TABLE_READ_ATTEMPTS {
        let current_size = u32::try_from(buffer.len())
            .map_err(|_| format!("{label} buffer size cannot be represented by Windows."))?;
        let mut logical_size = current_size;
        let status = call(Some(&mut buffer), &mut logical_size);

        if status == ERROR_SUCCESS {
            let logical_size = usize::try_from(logical_size)
                .map_err(|_| format!("{label} returned an impossible logical size."))?;
            if !(TABLE_HEADER_BYTES..=buffer.len()).contains(&logical_size) {
                return Err(format!(
                    "{label} returned logical size {logical_size} for a {}-byte buffer.",
                    buffer.len()
                ));
            }
            buffer.truncate(logical_size);
            return Ok(buffer);
        }

        if status != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "{label} read attempt {attempt} returned error code {status}."
            ));
        }

        if attempt == MAX_TABLE_READ_ATTEMPTS {
            return Err(format!(
                "{label} changed during all {MAX_TABLE_READ_ATTEMPTS} allocated read attempts."
            ));
        }

        if logical_size <= current_size {
            return Err(format!(
                "{label} reported an insufficient buffer without increasing the required size beyond {current_size} bytes."
            ));
        }

        buffer = allocate_table_buffer(label, logical_size)?;
    }

    unreachable!("bounded table-read loop always returns")
}

#[cfg(target_os = "windows")]
fn allocate_table_buffer(label: &str, size: u32) -> Result<Vec<u8>, String> {
    let size = usize::try_from(size)
        .map_err(|_| format!("{label} reported an impossible buffer size."))?;
    if !(TABLE_HEADER_BYTES..=MAX_TABLE_BYTES).contains(&size) {
        return Err(format!(
            "{label} reported invalid buffer size {size}; expected {TABLE_HEADER_BYTES}..={MAX_TABLE_BYTES}."
        ));
    }

    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(size)
        .map_err(|error| format!("Unable to allocate {size} bytes for {label}: {error}"))?;
    buffer.resize(size, 0);
    Ok(buffer)
}

#[cfg(target_os = "windows")]
/// A Win32 owner-PID row that is safe to copy from any initialized byte sequence.
///
/// # Safety
///
/// Implementors must contain only fields for which every bit pattern is valid,
/// and `TABLE_OFFSET` must be the offset of the first row in the matching
/// variable-length Win32 table type.
unsafe trait IpHelperTableRow: Copy {
    const TABLE_OFFSET: usize;
}

// SAFETY: the row contains only `u32` fields, and the offset comes from the
// matching `#[repr(C)]` windows-sys table binding.
unsafe impl IpHelperTableRow for MIB_TCPROW_OWNER_PID {
    const TABLE_OFFSET: usize = offset_of!(MIB_TCPTABLE_OWNER_PID, table);
}

// SAFETY: the row contains only byte arrays and `u32` fields, and the offset
// comes from the matching `#[repr(C)]` windows-sys table binding.
unsafe impl IpHelperTableRow for MIB_TCP6ROW_OWNER_PID {
    const TABLE_OFFSET: usize = offset_of!(MIB_TCP6TABLE_OWNER_PID, table);
}

// SAFETY: the row contains only `u32` fields, and the offset comes from the
// matching `#[repr(C)]` windows-sys table binding.
unsafe impl IpHelperTableRow for MIB_UDPROW_OWNER_PID {
    const TABLE_OFFSET: usize = offset_of!(MIB_UDPTABLE_OWNER_PID, table);
}

// SAFETY: the row contains only a byte array and `u32` fields, and the offset
// comes from the matching `#[repr(C)]` windows-sys table binding.
unsafe impl IpHelperTableRow for MIB_UDP6ROW_OWNER_PID {
    const TABLE_OFFSET: usize = offset_of!(MIB_UDP6TABLE_OWNER_PID, table);
}

#[cfg(target_os = "windows")]
fn decode_rows<Row: IpHelperTableRow, F>(
    bytes: &[u8],
    label: &str,
    mut convert: F,
) -> Result<Vec<EndpointRecord>, String>
where
    F: FnMut(Row) -> EndpointRecord,
{
    if bytes.len() < TABLE_HEADER_BYTES {
        return Err(format!("{label} table is shorter than its count header."));
    }
    if Row::TABLE_OFFSET < TABLE_HEADER_BYTES {
        return Err(format!(
            "{label} table row offset {} overlaps its count header.",
            Row::TABLE_OFFSET
        ));
    }

    let count = u32::from_ne_bytes(bytes[..TABLE_HEADER_BYTES].try_into().unwrap()) as usize;
    let rows_bytes = count
        .checked_mul(size_of::<Row>())
        .ok_or_else(|| format!("{label} row count overflows the returned buffer length."))?;
    let required_bytes = Row::TABLE_OFFSET
        .checked_add(rows_bytes)
        .ok_or_else(|| format!("{label} table length overflowed."))?;

    if required_bytes > bytes.len() {
        return Err(format!(
            "{label} declares {count} rows requiring {required_bytes} bytes, but only {} bytes were returned.",
            bytes.len()
        ));
    }

    let mut records = Vec::new();
    records
        .try_reserve_exact(count)
        .map_err(|error| format!("Unable to allocate {count} decoded {label} rows: {error}"))?;

    for index in 0..count {
        let offset = Row::TABLE_OFFSET + index * size_of::<Row>();
        // SAFETY: required_bytes was checked against bytes.len(), the computed
        // offset lies within that region, `IpHelperTableRow` guarantees every
        // bit pattern is valid, and read_unaligned copies rather than forming
        // an aligned reference into the byte buffer.
        let row = unsafe { bytes.as_ptr().add(offset).cast::<Row>().read_unaligned() };
        records.push(convert(row));
    }

    Ok(records)
}

#[cfg(target_os = "windows")]
fn tcp_v4_record(row: MIB_TCPROW_OWNER_PID) -> EndpointRecord {
    let local_ip = ipv4_address(row.dwLocalAddr);
    let (remote_ip, remote_port) = if row.dwState == 2 {
        (Ipv4Addr::UNSPECIFIED.to_string(), 0)
    } else {
        (
            ipv4_address(row.dwRemoteAddr),
            network_port(row.dwRemotePort),
        )
    };
    EndpointRecord {
        endpoint: EndpointKey {
            address_family: AddressFamily::Ipv4,
            protocol: Protocol::Tcp,
            local_ip,
            local_scope_id: 0,
            local_port: network_port(row.dwLocalPort),
            remote_ip: Some(remote_ip),
            remote_scope_id: Some(0),
            remote_port: Some(remote_port),
        },
        state: tcp_state_name(row.dwState).to_string(),
        pid: row.dwOwningPid,
    }
}

#[cfg(target_os = "windows")]
fn tcp_v6_record(row: MIB_TCP6ROW_OWNER_PID) -> EndpointRecord {
    let (remote_ip, remote_scope_id, remote_port) = if row.dwState == 2 {
        (Ipv6Addr::UNSPECIFIED.to_string(), 0, 0)
    } else {
        (
            Ipv6Addr::from(row.ucRemoteAddr).to_string(),
            u32::from_be(row.dwRemoteScopeId),
            network_port(row.dwRemotePort),
        )
    };
    EndpointRecord {
        endpoint: EndpointKey {
            address_family: AddressFamily::Ipv6,
            protocol: Protocol::Tcp,
            local_ip: Ipv6Addr::from(row.ucLocalAddr).to_string(),
            local_scope_id: u32::from_be(row.dwLocalScopeId),
            local_port: network_port(row.dwLocalPort),
            remote_ip: Some(remote_ip),
            remote_scope_id: Some(remote_scope_id),
            remote_port: Some(remote_port),
        },
        state: tcp_state_name(row.dwState).to_string(),
        pid: row.dwOwningPid,
    }
}

#[cfg(target_os = "windows")]
fn udp_v4_record(row: MIB_UDPROW_OWNER_PID) -> EndpointRecord {
    EndpointRecord {
        endpoint: EndpointKey {
            address_family: AddressFamily::Ipv4,
            protocol: Protocol::Udp,
            local_ip: ipv4_address(row.dwLocalAddr),
            local_scope_id: 0,
            local_port: network_port(row.dwLocalPort),
            remote_ip: None,
            remote_scope_id: None,
            remote_port: None,
        },
        state: "BOUND".to_string(),
        pid: row.dwOwningPid,
    }
}

#[cfg(target_os = "windows")]
fn udp_v6_record(row: MIB_UDP6ROW_OWNER_PID) -> EndpointRecord {
    EndpointRecord {
        endpoint: EndpointKey {
            address_family: AddressFamily::Ipv6,
            protocol: Protocol::Udp,
            local_ip: Ipv6Addr::from(row.ucLocalAddr).to_string(),
            local_scope_id: u32::from_be(row.dwLocalScopeId),
            local_port: network_port(row.dwLocalPort),
            remote_ip: None,
            remote_scope_id: None,
            remote_port: None,
        },
        state: "BOUND".to_string(),
        pid: row.dwOwningPid,
    }
}

#[cfg(target_os = "windows")]
fn ipv4_address(address: u32) -> String {
    Ipv4Addr::from(u32::from_be(address)).to_string()
}

#[cfg(target_os = "windows")]
fn network_port(port: u32) -> u16 {
    u16::from_be(port as u16)
}

#[cfg(target_os = "windows")]
fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNKNOWN",
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct FakeMetadataSource {
        calls: Vec<u32>,
        values: HashMap<u32, ProcessMetadata>,
    }

    impl ProcessMetadataSource for FakeMetadataSource {
        fn process_metadata(&mut self, pid: u32) -> Option<ProcessMetadata> {
            self.calls.push(pid);
            self.values.get(&pid).cloned()
        }
    }

    #[derive(Default)]
    struct FakeTableSource {
        calls: Vec<TableKind>,
        failure: Option<TableKind>,
        records: HashMap<TableKind, Vec<EndpointRecord>>,
    }

    impl IpTableSource for FakeTableSource {
        fn read_records(&mut self, table: TableKind) -> Result<Vec<EndpointRecord>, String> {
            self.calls.push(table);
            if self.failure == Some(table) {
                Err("scripted failure".to_string())
            } else {
                Ok(self.records.get(&table).cloned().unwrap_or_default())
            }
        }
    }

    #[derive(Clone)]
    struct CallStep {
        status: u32,
        size: u32,
        payload: Vec<u8>,
    }

    fn run_script(steps: Vec<CallStep>) -> (Result<Vec<u8>, String>, usize) {
        let mut steps = VecDeque::from(steps);
        let mut calls = 0;
        let result = acquire_table("test table", |buffer, size| {
            calls += 1;
            let step = steps.pop_front().expect("unexpected table call");
            *size = step.size;
            if let Some(buffer) = buffer {
                let copy_len = step.payload.len().min(buffer.len());
                buffer[..copy_len].copy_from_slice(&step.payload[..copy_len]);
            }
            step.status
        });
        assert!(steps.is_empty());
        (result, calls)
    }

    fn success_payload(size: usize) -> Vec<u8> {
        let mut bytes = vec![0; size.max(TABLE_HEADER_BYTES)];
        bytes[..4].copy_from_slice(&0u32.to_ne_bytes());
        bytes
    }

    #[test]
    fn table_acquisition_succeeds_on_first_allocated_read_with_trailing_slack() {
        let capacity = 32;
        let mut payload = table_bytes::<MIB_UDPROW_OWNER_PID>(&[]);
        payload.resize(capacity, 0xa5);

        let (result, calls) = run_script(vec![
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: capacity as u32,
                payload: vec![],
            },
            CallStep {
                status: ERROR_SUCCESS,
                // Some IP Helper implementations leave pdwSize equal to the
                // input capacity on success. The row count remains authoritative.
                size: capacity as u32,
                payload,
            },
        ]);

        let bytes = result.unwrap();
        assert_eq!(calls, 2);
        assert_eq!(bytes.len(), capacity);
        assert!(
            decode_rows::<MIB_UDPROW_OWNER_PID, _>(&bytes, "UDP/IPv4", udp_v4_record)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn table_acquisition_succeeds_after_probe_and_resizes() {
        let (result, calls) = run_script(vec![
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 8,
                payload: vec![],
            },
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 16,
                payload: vec![],
            },
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 24,
                payload: vec![],
            },
            CallStep {
                status: ERROR_SUCCESS,
                size: 12,
                payload: success_payload(12),
            },
        ]);

        assert_eq!(calls, 4);
        assert_eq!(result.unwrap().len(), 12);
    }

    #[test]
    fn table_acquisition_exhausts_exactly_four_allocated_reads() {
        let mut steps = vec![CallStep {
            status: ERROR_INSUFFICIENT_BUFFER,
            size: 8,
            payload: vec![],
        }];
        steps.extend((0..MAX_TABLE_READ_ATTEMPTS).map(|attempt| CallStep {
            status: ERROR_INSUFFICIENT_BUFFER,
            size: 12 + attempt as u32 * 4,
            payload: vec![],
        }));

        let (result, calls) = run_script(steps);
        assert_eq!(calls, 1 + MAX_TABLE_READ_ATTEMPTS);
        assert!(result.unwrap_err().contains("all 4"));
    }

    #[test]
    fn table_acquisition_rejects_probe_errors_and_invalid_sizes() {
        let (error, _) = run_script(vec![CallStep {
            status: 5,
            size: 8,
            payload: vec![],
        }]);
        assert!(error.unwrap_err().contains("sizing probe"));

        let (error, _) = run_script(vec![CallStep {
            status: ERROR_INSUFFICIENT_BUFFER,
            size: 0,
            payload: vec![],
        }]);
        assert!(error.unwrap_err().contains("invalid buffer size"));

        let (error, _) = run_script(vec![CallStep {
            status: ERROR_INSUFFICIENT_BUFFER,
            size: MAX_TABLE_BYTES as u32 + 1,
            payload: vec![],
        }]);
        assert!(error.unwrap_err().contains("invalid buffer size"));
    }

    #[test]
    fn table_acquisition_rejects_allocated_read_errors_and_impossible_lengths() {
        let (error, calls) = run_script(vec![
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 8,
                payload: vec![],
            },
            CallStep {
                status: 5,
                size: 8,
                payload: vec![],
            },
        ]);
        assert_eq!(calls, 2);
        assert!(error.unwrap_err().contains("read attempt 1"));

        let (error, _) = run_script(vec![
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 8,
                payload: vec![],
            },
            CallStep {
                status: ERROR_SUCCESS,
                size: 12,
                payload: success_payload(8),
            },
        ]);
        let error = error.unwrap_err();
        assert!(error.contains("logical size 12"));
        assert!(error.contains("8-byte buffer"));

        let (error, _) = run_script(vec![
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 8,
                payload: vec![],
            },
            CallStep {
                status: ERROR_SUCCESS,
                size: 3,
                payload: success_payload(8),
            },
        ]);
        assert!(error.unwrap_err().contains("logical size 3"));
    }

    #[test]
    fn table_acquisition_rejects_non_growing_resize_reports() {
        let (error, calls) = run_script(vec![
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 8,
                payload: vec![],
            },
            CallStep {
                status: ERROR_INSUFFICIENT_BUFFER,
                size: 8,
                payload: vec![],
            },
        ]);

        assert_eq!(calls, 2);
        assert!(error.unwrap_err().contains("without increasing"));
    }

    fn table_bytes<Row: IpHelperTableRow>(rows: &[Row]) -> Vec<u8> {
        let mut bytes = vec![0xa5; Row::TABLE_OFFSET + std::mem::size_of_val(rows)];
        bytes[..TABLE_HEADER_BYTES].copy_from_slice(&(rows.len() as u32).to_ne_bytes());
        // SAFETY: the destination region was sized for exactly rows and does
        // not overlap the source slice; bytes are copied without typed access.
        unsafe {
            std::ptr::copy_nonoverlapping(
                rows.as_ptr().cast::<u8>(),
                bytes.as_mut_ptr().add(Row::TABLE_OFFSET),
                std::mem::size_of_val(rows),
            );
        }
        bytes
    }

    #[repr(C, align(8))]
    #[derive(Clone, Copy)]
    struct PaddedRow {
        value: u64,
    }

    #[repr(C)]
    struct PaddedTable {
        count: u32,
        table: [PaddedRow; 1],
    }

    // SAFETY: `PaddedRow` contains only a `u64`, for which every bit pattern is
    // valid, and the offset comes from its matching test table layout.
    unsafe impl IpHelperTableRow for PaddedRow {
        const TABLE_OFFSET: usize = offset_of!(PaddedTable, table);
    }

    fn v4_table_address(address: Ipv4Addr) -> u32 {
        u32::from_ne_bytes(address.octets())
    }

    fn table_port(port: u16) -> u32 {
        port.to_be() as u32
    }

    #[test]
    fn decodes_ipv4_tcp_and_udp_rows() {
        let tcp = MIB_TCPROW_OWNER_PID {
            dwState: 2,
            dwLocalAddr: v4_table_address(Ipv4Addr::LOCALHOST),
            dwLocalPort: table_port(443),
            dwRemoteAddr: v4_table_address(Ipv4Addr::new(1, 2, 3, 4)),
            dwRemotePort: table_port(9999),
            dwOwningPid: 42,
        };
        let udp = MIB_UDPROW_OWNER_PID {
            dwLocalAddr: v4_table_address(Ipv4Addr::UNSPECIFIED),
            dwLocalPort: table_port(5353),
            dwOwningPid: 7,
        };

        let tcp_records =
            decode_rows::<MIB_TCPROW_OWNER_PID, _>(&table_bytes(&[tcp]), "TCP/IPv4", tcp_v4_record)
                .unwrap();
        let udp_records =
            decode_rows::<MIB_UDPROW_OWNER_PID, _>(&table_bytes(&[udp]), "UDP/IPv4", udp_v4_record)
                .unwrap();

        assert_eq!(tcp_records[0].endpoint.local_ip, "127.0.0.1");
        assert_eq!(tcp_records[0].endpoint.local_port, 443);
        assert_eq!(
            tcp_records[0].endpoint.remote_ip.as_deref(),
            Some("0.0.0.0")
        );
        assert_eq!(tcp_records[0].endpoint.remote_port, Some(0));
        assert_eq!(tcp_records[0].state, "LISTEN");
        assert_eq!(udp_records[0].endpoint.local_ip, "0.0.0.0");
        assert_eq!(udp_records[0].endpoint.remote_ip, None);
        assert_eq!(udp_records[0].state, "BOUND");
    }

    #[test]
    fn decodes_and_formats_scoped_ipv6_tcp_and_udp_rows() {
        let tcp = MIB_TCP6ROW_OWNER_PID {
            ucLocalAddr: Ipv6Addr::LOCALHOST.octets(),
            dwLocalScopeId: 0,
            dwLocalPort: table_port(443),
            ucRemoteAddr: "fe80::1".parse::<Ipv6Addr>().unwrap().octets(),
            dwRemoteScopeId: 12u32.to_be(),
            dwRemotePort: table_port(8443),
            dwState: 5,
            dwOwningPid: 42,
        };
        let udp = MIB_UDP6ROW_OWNER_PID {
            ucLocalAddr: "fe80::1".parse::<Ipv6Addr>().unwrap().octets(),
            dwLocalScopeId: 12u32.to_be(),
            dwLocalPort: table_port(5353),
            dwOwningPid: 7,
        };

        let mut records = decode_rows::<MIB_TCP6ROW_OWNER_PID, _>(
            &table_bytes(&[tcp]),
            "TCP/IPv6",
            tcp_v6_record,
        )
        .unwrap();
        records.extend(
            decode_rows::<MIB_UDP6ROW_OWNER_PID, _>(
                &table_bytes(&[udp]),
                "UDP/IPv6",
                udp_v6_record,
            )
            .unwrap(),
        );
        let entries = enrich_records(records, &mut FakeMetadataSource::default());

        assert_eq!(entries[0].local_address, "[::1]:443");
        assert_eq!(entries[0].remote_address, "[fe80::1%12]:8443");
        assert_eq!(entries[1].local_address, "[fe80::1%12]:5353");
        assert_eq!(entries[1].remote_address, "");
        assert!(entries.iter().all(|entry| !entry.can_terminate));
        assert!(entries
            .iter()
            .all(|entry| entry.protection_reason == "identity_unavailable"));
    }

    #[test]
    fn decoder_uses_table_offset_and_supports_unaligned_input() {
        const { assert!(PaddedRow::TABLE_OFFSET > TABLE_HEADER_BYTES) };
        let bytes = table_bytes(&[PaddedRow { value: 0x1234 }]);
        assert_eq!(
            &bytes[TABLE_HEADER_BYTES..PaddedRow::TABLE_OFFSET],
            vec![0xa5; PaddedRow::TABLE_OFFSET - TABLE_HEADER_BYTES]
        );

        let mut unaligned = vec![0xff];
        unaligned.extend_from_slice(&bytes);
        let records = decode_rows::<PaddedRow, _>(&unaligned[1..], "padded test", |row| {
            udp_record(row.value as u16, 1, AddressFamily::Ipv4, "0.0.0.0")
        })
        .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].endpoint.local_port, 0x1234);
    }

    #[test]
    fn decoder_rejects_truncated_headers_rows_and_impossible_counts() {
        assert!(
            decode_rows::<MIB_UDPROW_OWNER_PID, _>(&[0, 0, 0], "UDP/IPv4", udp_v4_record)
                .unwrap_err()
                .contains("count header")
        );

        let mut truncated = vec![0u8; TABLE_HEADER_BYTES];
        truncated[..4].copy_from_slice(&1u32.to_ne_bytes());
        assert!(
            decode_rows::<MIB_UDPROW_OWNER_PID, _>(&truncated, "UDP/IPv4", udp_v4_record,)
                .unwrap_err()
                .contains("declares 1 rows")
        );

        truncated[..4].copy_from_slice(&u32::MAX.to_ne_bytes());
        assert!(
            decode_rows::<MIB_TCP6ROW_OWNER_PID, _>(&truncated, "TCP/IPv6", tcp_v6_record,)
                .is_err()
        );
    }

    fn udp_record(port: u16, pid: u32, family: AddressFamily, ip: &str) -> EndpointRecord {
        EndpointRecord {
            endpoint: EndpointKey {
                address_family: family,
                protocol: Protocol::Udp,
                local_ip: ip.to_string(),
                local_scope_id: 0,
                local_port: port,
                remote_ip: None,
                remote_scope_id: None,
                remote_port: None,
            },
            state: "BOUND".to_string(),
            pid,
        }
    }

    #[test]
    fn full_scan_is_sorted_cached_and_rejects_any_table_failure() {
        let mut tables = FakeTableSource::default();
        tables.records.insert(
            TableKind::UdpIpv6,
            vec![udp_record(5353, 9, AddressFamily::Ipv6, "::1")],
        );
        tables.records.insert(
            TableKind::UdpIpv4,
            vec![
                udp_record(5353, 9, AddressFamily::Ipv4, "127.0.0.1"),
                udp_record(53, 9, AddressFamily::Ipv4, "0.0.0.0"),
            ],
        );
        let mut metadata = FakeMetadataSource::default();
        metadata.values.insert(
            9,
            ProcessMetadata {
                creation_time: 0x01dc_beef_1234_5678,
                process_name: "dns.exe".to_string(),
                process_path: "C:\\tools\\dns.exe".to_string(),
            },
        );

        let entries = list_port_entries_with(&mut tables, &mut metadata).unwrap();
        assert_eq!(
            entries.iter().map(|entry| entry.port).collect::<Vec<_>>(),
            vec![53, 5353, 5353]
        );
        assert_eq!(entries[1].endpoint.address_family, AddressFamily::Ipv4);
        assert_eq!(entries[2].endpoint.address_family, AddressFamily::Ipv6);
        assert_eq!(metadata.calls, vec![9]);
        assert_eq!(
            entries[0].process_instance_id.as_deref(),
            Some("01dcbeef12345678")
        );
        assert!(entries[0].can_terminate);
        assert_eq!(entries[0].protection_reason, "");
        assert_eq!(
            entries[0].entry_id,
            endpoint_entry_id(
                &entries[0].endpoint,
                entries[0].pid,
                entries[0].process_instance_id.as_deref(),
            )
        );

        for (index, failing_table) in TableKind::ALL.into_iter().enumerate() {
            let mut failing_tables = FakeTableSource {
                failure: Some(failing_table),
                ..FakeTableSource::default()
            };
            let error =
                list_port_entries_with(&mut failing_tables, &mut FakeMetadataSource::default())
                    .unwrap_err();
            assert!(error.contains(failing_table.label()));
            assert_eq!(failing_tables.calls, TableKind::ALL[..=index]);
        }
    }

    #[test]
    fn ownership_check_reads_only_the_selected_table_and_compares_pid() {
        let target = udp_record(5353, 42, AddressFamily::Ipv6, "::1");
        let endpoint = target.endpoint.clone();
        let mut tables = FakeTableSource::default();
        tables.records.insert(TableKind::UdpIpv6, vec![target]);

        assert!(endpoint_owned_by_pid_with(&mut tables, &endpoint, 42).unwrap());
        assert_eq!(tables.calls, vec![TableKind::UdpIpv6]);

        let mut tables = FakeTableSource::default();
        tables.records.insert(
            TableKind::UdpIpv6,
            vec![udp_record(5353, 7, AddressFamily::Ipv6, "::1")],
        );
        assert!(!endpoint_owned_by_pid_with(&mut tables, &endpoint, 42).unwrap());
    }

    #[test]
    #[ignore = "read-only Windows integration smoke test"]
    fn windows_inventory_smoke_reads_all_four_tables() {
        let entries = list_port_entries(&mut FakeMetadataSource::default()).unwrap();
        assert!(entries
            .iter()
            .all(|entry| entry.endpoint.validate().is_ok()));
    }
}
