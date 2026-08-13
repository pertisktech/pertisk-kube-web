use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
        State,
    },
    response::Response,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use kube::{
    api::{ApiResource, DynamicObject, GroupVersionKind, ListParams},
    Api, runtime::watcher,
};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};
use tracing::{error, info, warn};

use crate::AppState;

fn is_forbidden_or_missing_api(err: &kube::Error) -> bool {
    matches!(err, kube::Error::Api(api_err) if api_err.code == 403 || api_err.code == 404)
}

fn is_forbidden_or_missing_watch_api(err: &watcher::Error) -> bool {
    match err {
        watcher::Error::WatchError(api_err) => api_err.code == 403 || api_err.code == 404,
        watcher::Error::WatchFailed(client_err)
        | watcher::Error::InitialListFailed(client_err)
        | watcher::Error::WatchStartFailed(client_err) => is_forbidden_or_missing_api(client_err),
        _ => false,
    }
}

const PREFERRED_SHELL_SCRIPT: &str = "if [ -x /bin/zsh ]; then exec /bin/zsh -il; elif command -v zsh >/dev/null 2>&1; then exec zsh -il; elif [ -x /bin/bash ]; then exec /bin/bash -il; elif command -v bash >/dev/null 2>&1; then exec bash -il; else exec /bin/sh -i; fi";

fn node_debug_namespace() -> String {
    env::var("NODE_DEBUG_NAMESPACE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("POD_NAMESPACE")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "default".to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Subscribe { resource: String },
    Unsubscribe { resource: String },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    ResourceUpdate {
        resource: String,
        action: String,
        data: serde_json::Value,
    },
    Error {
        message: String,
    },
    Subscribed {
        resource: String,
    },
    Unsubscribed {
        resource: String,
    },
    Pong,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecQuery {
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
}

fn parse_resize_message(text: &str) -> Option<(u16, u16)> {
    let json = serde_json::from_str::<serde_json::Value>(text).ok()?;
    if json.get("type").and_then(|value| value.as_str()) != Some("resize") {
        return None;
    }

    let cols = json.get("cols").and_then(|value| value.as_u64())?;
    let rows = json.get("rows").and_then(|value| value.as_u64())?;

    if cols == 0 || rows == 0 {
        return None;
    }

    let cols = u16::try_from(cols).ok()?;
    let rows = u16::try_from(rows).ok()?;

    Some((cols, rows))
}

enum ShellSession {
    Pty {
        master: Box<dyn MasterPty + Send>,
        reader: Box<dyn std::io::Read + Send>,
        writer: Box<dyn std::io::Write + Send>,
    },
    Piped {
        child: Child,
        stdin: ChildStdin,
        stdout: ChildStdout,
        stderr: ChildStderr,
    },
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    info!("New WebSocket connection request");
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

pub async fn exec_ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<ExecQuery>,
) -> Response {
    info!(
        "New exec websocket request: namespace={}, pod={}, container={:?}",
        query.namespace, query.pod, query.container
    );

    ws.on_upgrade(move |socket| handle_exec_socket(socket, query))
}

async fn spawn_exec_shell(
    query: &ExecQuery,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Option<ShellSession> {
    info!(
        "Starting exec shell: namespace={}, pod={}, container={:?}",
        query.namespace, query.pod, query.container
    );

    if query.namespace == "host" && query.pod == "host" {
        // Special case: connect to host shell with PTY
        info!("Connecting to host shell with PTY");        
        let pty_system = NativePtySystem::default();        let pair = match pty_system.openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(err) => {
                error!("Failed to create PTY: {}", err);
                let _ = tx
                    .send(format!(
                        "\r\n\u{1b}[1;31mFailed to create PTY: {}\u{1b}[0m\r\n",
                        err
                    ))
                    .await;
                return None;
            }
        };

        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/appuser".to_string());
        let path = format!("{}/.local/bin:/usr/local/bin:/usr/bin:/bin", home);
        
        let mut cmd = CommandBuilder::new("zsh");
        cmd.arg("-i");
        cmd.arg("-l");  // Login shell to read /etc/profile and /etc/environment
        cmd.env("HOME", &home);
        cmd.env("ZSH", format!("{}/.oh-my-zsh", home));
        cmd.env("PATH", path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD", "true");
        cmd.env("ZDOTDIR", &home);
        
        // Spawn the shell process
        if let Err(err) = pair.slave.spawn_command(cmd) {
            error!("Failed to spawn zsh: {}", err);
            let _ = tx
                .send(format!(
                    "\r\n\u{1b}[1;31mFailed to spawn zsh: {}\u{1b}[0m\r\n",
                    err
                ))
                .await;
            return None;
        }

        info!("PTY shell process spawned successfully");
        
        // Get reader and writer from the master side
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        
        Some(ShellSession::Pty { 
            master: pair.master,
            reader, 
            writer,
        })
    } else if query.namespace == "node" {
        // Node shell: kubectl debug node/<nodename> with a privileged alpine pod
        info!("Connecting to node shell for node: {}", query.pod);
        let debug_namespace = node_debug_namespace();
        let mut cmd = Command::new("kubectl");
        cmd.arg("debug")
            .arg("-n")
            .arg(&debug_namespace)
            .arg(format!("node/{}", query.pod))
            .arg("-i")
            .arg("-q")
            .arg("--profile=sysadmin")
            .arg("--image=alpine")
            .arg("--")
            .arg("chroot")
            .arg("/host")
            .arg("/bin/sh")
            .arg("-lc")
            .arg(PREFERRED_SHELL_SCRIPT);

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                error!("Failed to spawn kubectl debug node: {}", err);
                let _ = tx
                    .send(format!(
                        "\r\n\u{1b}[1;31mFailed to start node shell: {}\u{1b}[0m\r\n",
                        err
                    ))
                    .await;
                return None;
            }
        };

        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let stderr = child.stderr.take()?;

        Some(ShellSession::Piped {
            child,
            stdin,
            stdout,
            stderr,
        })
    } else {
        // Normal case: kubectl exec to pod with PTY so zsh/p10k get a real terminal
        let pty_system = NativePtySystem::default();
        let pair = match pty_system.openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(err) => {
                error!("Failed to create PTY for kubectl exec: {}", err);
                let _ = tx
                    .send(format!(
                        "\r\n\u{1b}[1;31mFailed to create PTY: {}\u{1b}[0m\r\n",
                        err
                    ))
                    .await;
                return None;
            }
        };

        let mut cmd = CommandBuilder::new("kubectl");
        cmd.arg("exec");
        cmd.arg("-i");
        cmd.arg("-t"); // Works now — we have a real local PTY
        cmd.arg("-n");
        cmd.arg(&query.namespace);
        cmd.arg(&query.pod);

        if let Some(container) = &query.container {
            cmd.arg("-c");
            cmd.arg(container);
        }

        cmd.arg("--");
        cmd.arg("/bin/sh");
        cmd.arg("-lc");
        cmd.arg(PREFERRED_SHELL_SCRIPT);
        cmd.env("TERM", "xterm-256color");

        if let Err(err) = pair.slave.spawn_command(cmd) {
            error!("Failed to spawn kubectl exec: {}", err);
            let _ = tx
                .send(format!(
                    "\r\n\u{1b}[1;31mFailed to start kubectl exec: {}\u{1b}[0m\r\n",
                    err
                ))
                .await;
            return None;
        }

        info!("kubectl exec PTY process spawned successfully");

        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(err) => {
                error!("Failed to clone PTY reader: {}", err);
                return None;
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(err) => {
                error!("Failed to take PTY writer: {}", err);
                return None;
            }
        };

        Some(ShellSession::Pty {
            master: pair.master,
            reader,
            writer,
        })
    }
}

fn extract_debug_pod_name(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let rest = trimmed.strip_prefix("Creating debugging pod ")?;
        rest.split_whitespace().next().map(str::to_string)
    })
}

async fn cleanup_node_debug_pod(pod_name: Option<String>) {
    let Some(pod_name) = pod_name else {
        return;
    };
    let debug_namespace = node_debug_namespace();

    let result = Command::new("kubectl")
        .arg("delete")
        .arg("pod")
        .arg(&pod_name)
        .arg("-n")
        .arg(&debug_namespace)
        .arg("--ignore-not-found=true")
        .arg("--wait=false")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    match result {
        Ok(status) if status.success() => {
            info!("Deleted node debug pod: {}", pod_name);
        }
        Ok(status) => {
            warn!("Failed deleting node debug pod {}: exit status {}", pod_name, status);
        }
        Err(err) => {
            warn!("Failed deleting node debug pod {}: {}", pod_name, err);
        }
    }
}

fn sanitize_piped_output(
    output: String,
    suppress_kubectl_debug_noise: bool,
    node_debug_pod_name: Option<&Arc<Mutex<Option<String>>>>,
) -> Option<String> {
    if let Some(pod_name) = extract_debug_pod_name(&output) {
        if let Some(shared_name) = node_debug_pod_name {
            if let Ok(mut slot) = shared_name.lock() {
                *slot = Some(pod_name);
            }
        }
    }

    if !suppress_kubectl_debug_noise {
        return if output.is_empty() { None } else { Some(output) };
    }

    let filtered_lines: Vec<&str> = output
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("Creating debugging pod ")
                && !trimmed.starts_with("If you don't see a command prompt")
                && !trimmed.starts_with("warning: couldn't attach to pod/")
                && !trimmed.starts_with("Unable to use a TTY")
        })
        .collect();

    if filtered_lines.is_empty() {
        return None;
    }

    let mut filtered = filtered_lines.join("\n");
    if output.ends_with('\n') {
        filtered.push('\n');
    }

    if filtered.trim().is_empty() {
        None
    } else {
        Some(filtered)
    }
}

fn spawn_output_tasks(
    mut child_stdout: ChildStdout,
    mut child_stderr: ChildStderr,
    tx: tokio::sync::mpsc::Sender<String>,
    suppress_kubectl_debug_noise: bool,
    node_debug_pod_name: Option<Arc<Mutex<Option<String>>>>,
) -> (JoinHandle<()>, JoinHandle<()>) {
    let tx_stdout = tx.clone();
    let node_debug_pod_name_stdout = node_debug_pod_name.clone();
    let stdout_task = tokio::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            match child_stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let Some(output) = sanitize_piped_output(
                        output,
                        suppress_kubectl_debug_noise,
                        node_debug_pod_name_stdout.as_ref(),
                    ) else {
                        continue;
                    };
                    if tx_stdout.send(output).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx_stdout
                        .send(format!("\r\n\u{1b}[1;31mstdout error: {}\u{1b}[0m\r\n", err))
                        .await;
                    break;
                }
            }
        }
    });

    let tx_stderr = tx.clone();
    let node_debug_pod_name_stderr = node_debug_pod_name;
    let stderr_task = tokio::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            match child_stderr.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let Some(output) = sanitize_piped_output(
                        output,
                        suppress_kubectl_debug_noise,
                        node_debug_pod_name_stderr.as_ref(),
                    ) else {
                        continue;
                    };
                    if tx_stderr.send(output).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx_stderr
                        .send(format!("\r\n\u{1b}[1;31mstderr error: {}\u{1b}[0m\r\n", err))
                        .await;
                    break;
                }
            }
        }
    });

    (stdout_task, stderr_task)
}

async fn handle_exec_socket(socket: WebSocket, query: ExecQuery) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);

    let ws_send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    let session = match spawn_exec_shell(&query, &tx).await {
        Some(session) => session,
        None => {
            ws_send_task.abort();
            return;
        }
    };

    match session {
        ShellSession::Pty { master, reader, writer } => {
            handle_pty_session(ws_receiver, master, reader, writer, tx.clone()).await;
        }
        ShellSession::Piped { mut child, mut stdin, stdout, stderr } => {
            // Keep live shell output byte-faithful to avoid line-break corruption in chunked streams.
            // kubectl debug banners are suppressed via -q for node sessions.
            let suppress_kubectl_debug_noise = false;
            let mut node_debug_pod_name = if query.namespace == "node" {
                Some(Arc::new(Mutex::new(None)))
            } else {
                None
            };
            let (mut stdout_task, mut stderr_task) =
                spawn_output_tasks(
                    stdout,
                    stderr,
                    tx.clone(),
                    suppress_kubectl_debug_noise,
                    node_debug_pod_name.clone(),
                );

            while let Some(message) = ws_receiver.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if text == "\u{3}" {
                            let _ = child.kill().await;
                            stdout_task.abort();
                            stderr_task.abort();
                            let pod_name = node_debug_pod_name
                                .as_ref()
                                .and_then(|shared| shared.lock().ok().and_then(|slot| slot.clone()));
                            cleanup_node_debug_pod(pod_name).await;

                            let _ = tx.send("\r\n^C\r\n".to_string()).await;

                            match spawn_exec_shell(&query, &tx).await {
                                Some(ShellSession::Piped { child: new_child, stdin: new_stdin, stdout: new_stdout, stderr: new_stderr }) => {
                                    child = new_child;
                                    stdin = new_stdin;
                                    node_debug_pod_name = if suppress_kubectl_debug_noise {
                                        Some(Arc::new(Mutex::new(None)))
                                    } else {
                                        None
                                    };
                                    let tasks = spawn_output_tasks(
                                        new_stdout,
                                        new_stderr,
                                        tx.clone(),
                                        suppress_kubectl_debug_noise,
                                        node_debug_pod_name.clone(),
                                    );
                                    stdout_task = tasks.0;
                                    stderr_task = tasks.1;
                                    continue;
                                }
                                _ => break,
                            }
                        }

                        if let Some(_) = parse_resize_message(&text) {
                            // For kubectl exec piped shells, resize is not directly supported
                            // The stty command would be echoed as visible input
                            // Only handle resize in the PTY case below
                            continue;
                        }

                        // In piped mode (no PTY), normalize CR to LF so commands execute with
                        // proper line breaks and output starts on a new line.
                        let normalized = text.replace('\r', "\n");
                        if stdin.write_all(normalized.as_bytes()).await.is_err() {
                            error!("Failed to write to stdin");
                            break;
                        }

                        if let Err(e) = stdin.flush().await {
                            error!("Failed to flush stdin: {}", e);
                            break;
                        }
                    }
                    Ok(Message::Binary(data)) => {
                        if stdin.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) => {}
                    Ok(Message::Pong(_)) => {}
                    Err(err) => {
                        warn!("Exec websocket receive error: {}", err);
                        break;
                    }
                }
            }

            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            let pod_name = node_debug_pod_name
                .as_ref()
                .and_then(|shared| shared.lock().ok().and_then(|slot| slot.clone()));
            cleanup_node_debug_pod(pod_name).await;
        }
    }

    ws_send_task.abort();

    info!(
        "Exec websocket closed: namespace={}, pod={}, container={:?}",
        query.namespace, query.pod, query.container
    );
}

async fn handle_pty_session(
    mut ws_receiver: futures_util::stream::SplitStream<WebSocket>,
    master: Box<dyn MasterPty + Send>,
    mut reader: Box<dyn std::io::Read + Send>,
    mut writer: Box<dyn std::io::Write + Send>,
    tx: tokio::sync::mpsc::Sender<String>,
) {
    // PTY output reading task (blocking I/O in separate thread)
    let read_task = tokio::task::spawn_blocking(move || {
        let mut buffer = [0u8; 4096];
        
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                    if tx.blocking_send(output).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Handle WebSocket messages
    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(Message::Text(text)) => {
                if let Some((cols, rows)) = parse_resize_message(&text) {
                    // Handle terminal resize
                    info!("Resizing PTY to {}x{}", cols, rows);
                    if let Err(e) = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    }) {
                        warn!("Failed to resize PTY: {}", e);
                    }
                    continue;
                }

                // Write input to PTY
                if let Err(e) = writer.write_all(text.as_bytes()) {
                    error!("Failed to write to PTY: {}", e);
                    break;
                }
                if let Err(e) = writer.flush() {
                    error!("Failed to flush PTY: {}", e);
                    break;
                }
            }
            Ok(Message::Binary(data)) => {
                if let Err(e) = writer.write_all(&data) {
                    error!("Failed to write binary to PTY: {}", e);
                    break;
                }
                let _ = writer.flush();
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Err(err) => {
                warn!("PTY websocket receive error: {}", err);
                break;
            }
        }
    }

    read_task.abort();
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let connection_id = uuid::Uuid::new_v4().to_string();
    
    info!("WebSocket connection established: {}", connection_id);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<ServerMessage>(100);

    // Spawn task to send messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if sender.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
        }
    });

    // Handle incoming messages from client
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    match client_msg {
                        ClientMessage::Subscribe { resource } => {
                            info!("Client subscribing to {}", resource);
                            
                            // Send confirmation
                            let response = ServerMessage::Subscribed { resource: resource.clone() };
                            let _ = tx.send(response).await;

                            // Start watching resource based on type
                            let state_clone = state.clone();
                            let tx_clone = tx.clone();
                            let resource_clone = resource.clone();
                            
                            tokio::spawn(async move {
                                match resource_clone.as_str() {
                                    "pods" => watch_pods(state_clone, tx_clone).await,
                                    "namespaces" => watch_namespaces(state_clone, tx_clone).await,
                                    "deployments" => watch_deployments(state_clone, tx_clone).await,
                                    "statefulsets" => watch_statefulsets(state_clone, tx_clone).await,
                                    "daemonsets" => watch_daemonsets(state_clone, tx_clone).await,
                                    "replicasets" => watch_replicasets(state_clone, tx_clone).await,
                                    "jobs" => watch_jobs(state_clone, tx_clone).await,
                                    "cronjobs" => watch_cronjobs(state_clone, tx_clone).await,
                                    "events" => watch_events(state_clone, tx_clone).await,
                                    "nodes" => watch_nodes(state_clone, tx_clone).await,
                                    "services" => watch_services(state_clone, tx_clone).await,
                                    "configmaps" => watch_configmaps(state_clone, tx_clone).await,
                                    "secrets" => watch_secrets(state_clone, tx_clone).await,
                                    "resourcequotas" => watch_resourcequotas(state_clone, tx_clone).await,
                                    "limitranges" => watch_limitranges(state_clone, tx_clone).await,
                                    "hpa" => watch_hpa(state_clone, tx_clone).await,
                                    "pdb" => watch_pdb(state_clone, tx_clone).await,
                                    "ingresses" => watch_ingresses(state_clone, tx_clone).await,
                                    "ingressclasses" => watch_ingressclasses(state_clone, tx_clone).await,
                                    "endpoints" => watch_endpoints(state_clone, tx_clone).await,
                                    "networkpolicies" => watch_networkpolicies(state_clone, tx_clone).await,
                                    "persistentvolumes" => watch_persistentvolumes(state_clone, tx_clone).await,
                                    "persistentvolumeclaims" => watch_persistentvolumeclaims(state_clone, tx_clone).await,
                                    "storageclasses" => watch_storageclasses(state_clone, tx_clone).await,
                                    "serviceaccounts" => watch_serviceaccounts(state_clone, tx_clone).await,
                                    "clusterroles" => watch_clusterroles(state_clone, tx_clone).await,
                                    "clusterrolebindings" => watch_clusterrolebindings(state_clone, tx_clone).await,
                                    "roles" => watch_roles(state_clone, tx_clone).await,
                                    "rolebindings" => watch_rolebindings(state_clone, tx_clone).await,
                                    "priorityclasses" => watch_priorityclasses(state_clone, tx_clone).await,
                                    "runtimeclasses" => watch_runtimeclasses(state_clone, tx_clone).await,
                                    "leases" => watch_leases(state_clone, tx_clone).await,
                                    "mwc" => watch_mwcs(state_clone, tx_clone).await,
                                    "vwc" => watch_vwcs(state_clone, tx_clone).await,
                                    "crds" => watch_crds(state_clone, tx_clone).await,
                                    _ if resource_clone.starts_with("customresources/") => {
                                        let crd_name = resource_clone.strip_prefix("customresources/").unwrap_or("").to_string();
                                        if crd_name.is_empty() {
                                            let _ = tx_clone.send(ServerMessage::Error { message: "customresources/ requires CRD name".into() }).await;
                                        } else {
                                            watch_custom_resources(state_clone, tx_clone, &resource_clone, &crd_name).await;
                                        }
                                    }
                                    _ => {
                                        error!("Unknown resource type: {}", resource_clone);
                                        let msg = ServerMessage::Error {
                                            message: format!("Unknown resource type: {}", resource_clone),
                                        };
                                        let _ = tx_clone.send(msg).await;
                                    }
                                }
                            });
                        }
                        ClientMessage::Unsubscribe { resource } => {
                            info!("Client unsubscribing from {}", resource);
                            let response = ServerMessage::Unsubscribed { resource };
                            let _ = tx.send(response).await;
                        }
                        ClientMessage::Ping => {
                            let response = ServerMessage::Pong;
                            let _ = tx.send(response).await;
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => {
                info!("WebSocket connection closed: {}", connection_id);
                break;
            }
            Ok(Message::Ping(_)) => {
                // Echo pong - this is handled automatically by axum
                let _ = tx.send(ServerMessage::Pong).await;
            }
            Err(e) => {
                warn!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }

    send_task.abort();
    info!("WebSocket handler completed: {}", connection_id);
}

async fn watch_pods(
    state: AppState,
    tx: tokio::sync::mpsc::Sender<ServerMessage>,
) {
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::ListParams;

    let api: Api<Pod> = Api::all(state.kube_client().await);

    // First, send all existing pods (excluding those marked for deletion)
    info!("Fetching initial pod list...");
    match api.list(&ListParams::default()).await {
        Ok(pod_list) => {
            let total_pods = pod_list.items.len();
            let active_pods: Vec<_> = pod_list.items.into_iter()
                .filter(|pod| pod.metadata.deletion_timestamp.is_none())
                .collect();

            info!("Sending {} active pods (excluded {} terminating pods)",
                  active_pods.len(),
                  total_pods - active_pods.len());

            for pod in active_pods {
                let pod_data = serde_json::to_value(&pod).unwrap_or_default();

                let msg = ServerMessage::ResourceUpdate {
                    resource: "pods".to_string(),
                    action: "ADDED".to_string(),
                    data: pod_data,
                };

                if tx.send(msg).await.is_err() {
                    return; // Client disconnected
                }
            }
        }
        Err(e) => {
            if is_forbidden_or_missing_api(&e) {
                warn!("Skipping pod watch initialization due to unavailable/forbidden API: {}", e);
                return;
            }
            error!("Failed to fetch initial pod list: {}", e);
            let msg = ServerMessage::Error {
                message: format!("Failed to fetch initial pods: {}", e),
            };
            let _ = tx.send(msg).await;
            return;
        }
    }

    // Now watch for changes. If the watch stream drops due to transient network
    // issues, restart it so realtime pod updates keep flowing without page refresh.
    let mut retry_attempt: u32 = 0;
    loop {
        info!("Starting pod watch stream...");
        let mut stream = std::pin::Pin::from(Box::new(watcher(api.clone(), Default::default())));

        while let Some(result) = stream.next().await {
            match result {
                Ok(event) => {
                    retry_attempt = 0;
                    use kube::runtime::watcher::Event;

                    let (action, pod_opt) = match event {
                        Event::Applied(pod) => {
                            // Send terminating pods as MODIFIED so they show "Terminating" status
                            // They'll be removed by the DELETED event
                            ("MODIFIED", Some(pod))
                        }
                        Event::Deleted(pod) => ("DELETED", Some(pod)),
                        Event::Restarted(pods) => {
                            // Watcher restarted, send all active pods (skip terminating ones)
                            for pod in pods {
                                // Skip pods marked for deletion
                                if pod.metadata.deletion_timestamp.is_some() {
                                    continue;
                                }
                                let pod_data = serde_json::to_value(&pod).unwrap_or_default();
                                let msg = ServerMessage::ResourceUpdate {
                                    resource: "pods".to_string(),
                                    action: "MODIFIED".to_string(),
                                    data: pod_data,
                                };
                                if tx.send(msg).await.is_err() {
                                    return;
                                }
                            }
                            continue;
                        }
                    };

                    if let Some(pod) = pod_opt {
                        let pod_data = serde_json::to_value(&pod).unwrap_or_default();

                        // Log deletions for debugging
                        if action == "DELETED" {
                            if let Some(metadata) = pod_data.get("metadata") {
                                let name = metadata.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                                let namespace = metadata.get("namespace").and_then(|v| v.as_str()).unwrap_or("unknown");
                                info!("Sending DELETED event for pod: {}/{}", namespace, name);
                            }
                        }

                        let msg = ServerMessage::ResourceUpdate {
                            resource: "pods".to_string(),
                            action: action.to_string(),
                            data: pod_data,
                        };

                        if tx.send(msg).await.is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    if is_forbidden_or_missing_watch_api(&e) {
                        warn!("Stopping pod watch due to unavailable/forbidden API: {}", e);
                        return;
                    }
                    error!("Watch error: {}", e);
                    let msg = ServerMessage::Error {
                        message: format!("Watch error: {}", e),
                    };
                    let _ = tx.send(msg).await;
                    break;
                }
            }
        }

        retry_attempt = retry_attempt.saturating_add(1);
        let backoff_secs = std::cmp::min(10, retry_attempt);
        warn!(
            "pods watch stream ended; reconnecting in {}s (attempt {})",
            backoff_secs,
            retry_attempt
        );
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs as u64)).await;
    }
}

// Generic macro to create watch functions for any K8s resource type
macro_rules! create_watch_fn {
    ($fn_name:ident, $resource_type:ty, $resource_name:expr) => {
        async fn $fn_name(
            state: AppState,
            tx: tokio::sync::mpsc::Sender<ServerMessage>,
        ) {
            use kube::api::ListParams;

            let api: Api<$resource_type> = Api::all(state.kube_client().await);

            // First, send all existing resources
            info!("Fetching initial {} list...", $resource_name);
            match api.list(&ListParams::default()).await {
                Ok(list) => {
                    let total_items = list.items.len();

                    info!("Sending {} {}", total_items, $resource_name);

                    for item in list.items {
                        let item_data = serde_json::to_value(&item).unwrap_or_default();

                        let msg = ServerMessage::ResourceUpdate {
                            resource: $resource_name.to_string(),
                            action: "ADDED".to_string(),
                            data: item_data,
                        };

                        if tx.send(msg).await.is_err() {
                            return; // Client disconnected
                        }
                    }
                }
                Err(e) => {
                    if is_forbidden_or_missing_api(&e) {
                        warn!("Skipping {} watch initialization due to unavailable/forbidden API: {}", $resource_name, e);
                        return;
                    }
                    error!("Failed to fetch initial {} list: {}", $resource_name, e);
                    let msg = ServerMessage::Error {
                        message: format!("Failed to fetch initial {}: {}", $resource_name, e),
                    };
                    let _ = tx.send(msg).await;
                    return;
                }
            }

            // Now watch for changes. If the watch stream drops due to transient network
            // issues, restart it so realtime updates keep flowing without page refresh.
            let mut retry_attempt: u32 = 0;
            loop {
                info!("Starting {} watch stream...", $resource_name);
                let mut stream = std::pin::Pin::from(Box::new(watcher(api.clone(), Default::default())));

                while let Some(result) = stream.next().await {
                    match result {
                        Ok(event) => {
                            retry_attempt = 0;
                            use kube::runtime::watcher::Event;

                            let (action, item_opt) = match event {
                                Event::Applied(item) => ("MODIFIED", Some(item)),
                                Event::Deleted(item) => ("DELETED", Some(item)),
                                Event::Restarted(items) => {
                                    for item in items {
                                        let item_data = serde_json::to_value(&item).unwrap_or_default();
                                        let msg = ServerMessage::ResourceUpdate {
                                            resource: $resource_name.to_string(),
                                            action: "MODIFIED".to_string(),
                                            data: item_data,
                                        };
                                        if tx.send(msg).await.is_err() {
                                            return;
                                        }
                                    }
                                    continue;
                                }
                            };

                            if let Some(item) = item_opt {
                                let item_data = serde_json::to_value(&item).unwrap_or_default();

                                let msg = ServerMessage::ResourceUpdate {
                                    resource: $resource_name.to_string(),
                                    action: action.to_string(),
                                    data: item_data,
                                };

                                if tx.send(msg).await.is_err() {
                                    return;
                                }
                            }
                        }
                        Err(e) => {
                            if is_forbidden_or_missing_watch_api(&e) {
                                warn!("Stopping {} watch due to unavailable/forbidden API: {}", $resource_name, e);
                                return;
                            }
                            error!("Watch error for {}: {}", $resource_name, e);
                            let msg = ServerMessage::Error {
                                message: format!("Watch error: {}", e),
                            };
                            let _ = tx.send(msg).await;
                            break;
                        }
                    }
                }

                retry_attempt = retry_attempt.saturating_add(1);
                let backoff_secs = std::cmp::min(10, retry_attempt);
                warn!(
                    "{} watch stream ended; reconnecting in {}s (attempt {})",
                    $resource_name,
                    backoff_secs,
                    retry_attempt
                );
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs as u64)).await;
            }
        }
    };
}

// Create watch functions for each resource type
create_watch_fn!(watch_deployments, k8s_openapi::api::apps::v1::Deployment, "deployments");
create_watch_fn!(watch_statefulsets, k8s_openapi::api::apps::v1::StatefulSet, "statefulsets");
create_watch_fn!(watch_daemonsets, k8s_openapi::api::apps::v1::DaemonSet, "daemonsets");
create_watch_fn!(watch_replicasets, k8s_openapi::api::apps::v1::ReplicaSet, "replicasets");
create_watch_fn!(watch_jobs, k8s_openapi::api::batch::v1::Job, "jobs");
create_watch_fn!(watch_cronjobs, k8s_openapi::api::batch::v1::CronJob, "cronjobs");
create_watch_fn!(watch_events, k8s_openapi::api::core::v1::Event, "events");
create_watch_fn!(watch_namespaces, k8s_openapi::api::core::v1::Namespace, "namespaces");
create_watch_fn!(watch_nodes, k8s_openapi::api::core::v1::Node, "nodes");
create_watch_fn!(watch_services, k8s_openapi::api::core::v1::Service, "services");
create_watch_fn!(watch_configmaps, k8s_openapi::api::core::v1::ConfigMap, "configmaps");
create_watch_fn!(watch_secrets, k8s_openapi::api::core::v1::Secret, "secrets");
create_watch_fn!(watch_resourcequotas, k8s_openapi::api::core::v1::ResourceQuota, "resourcequotas");
create_watch_fn!(watch_limitranges, k8s_openapi::api::core::v1::LimitRange, "limitranges");
create_watch_fn!(watch_hpa, k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler, "hpa");
create_watch_fn!(watch_pdb, k8s_openapi::api::policy::v1::PodDisruptionBudget, "pdb");
create_watch_fn!(watch_ingresses, k8s_openapi::api::networking::v1::Ingress, "ingresses");
create_watch_fn!(watch_ingressclasses, k8s_openapi::api::networking::v1::IngressClass, "ingressclasses");
create_watch_fn!(watch_endpoints, k8s_openapi::api::core::v1::Endpoints, "endpoints");
create_watch_fn!(watch_networkpolicies, k8s_openapi::api::networking::v1::NetworkPolicy, "networkpolicies");
create_watch_fn!(watch_persistentvolumes, k8s_openapi::api::core::v1::PersistentVolume, "persistentvolumes");
create_watch_fn!(watch_persistentvolumeclaims, k8s_openapi::api::core::v1::PersistentVolumeClaim, "persistentvolumeclaims");
create_watch_fn!(watch_storageclasses, k8s_openapi::api::storage::v1::StorageClass, "storageclasses");
create_watch_fn!(watch_serviceaccounts, k8s_openapi::api::core::v1::ServiceAccount, "serviceaccounts");
create_watch_fn!(watch_clusterroles, k8s_openapi::api::rbac::v1::ClusterRole, "clusterroles");
create_watch_fn!(watch_clusterrolebindings, k8s_openapi::api::rbac::v1::ClusterRoleBinding, "clusterrolebindings");
create_watch_fn!(watch_roles, k8s_openapi::api::rbac::v1::Role, "roles");
create_watch_fn!(watch_rolebindings, k8s_openapi::api::rbac::v1::RoleBinding, "rolebindings");
create_watch_fn!(watch_priorityclasses, k8s_openapi::api::scheduling::v1::PriorityClass, "priorityclasses");
create_watch_fn!(watch_runtimeclasses, k8s_openapi::api::node::v1::RuntimeClass, "runtimeclasses");
create_watch_fn!(watch_leases, k8s_openapi::api::coordination::v1::Lease, "leases");
create_watch_fn!(watch_crds, k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition, "crds");

fn mwc_api_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("admissionregistration.k8s.io", "v1", "MutatingWebhookConfiguration"),
        "mutatingwebhookconfigurations",
    )
}

fn vwc_api_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("admissionregistration.k8s.io", "v1", "ValidatingWebhookConfiguration"),
        "validatingwebhookconfigurations",
    )
}

async fn watch_dynamic_cluster_resource(
    state: AppState,
    tx: tokio::sync::mpsc::Sender<ServerMessage>,
    ar: ApiResource,
    resource_name: &str,
) {
    let api: Api<DynamicObject> = Api::all_with(state.kube_client().await, &ar);
    info!("Fetching initial {} list...", resource_name);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            for item in list.items {
                let item_data = serde_json::to_value(&item).unwrap_or_default();
                if tx.send(ServerMessage::ResourceUpdate {
                    resource: resource_name.to_string(),
                    action: "ADDED".to_string(),
                    data: item_data,
                })
                .await
                .is_err()
                {
                    return;
                }
            }
        }
        Err(e) => {
            error!("Failed to fetch initial {} list: {}", resource_name, e);
            let _ = tx.send(ServerMessage::Error {
                message: format!("Failed to fetch initial {}: {}", resource_name, e),
            })
            .await;
            return;
        }
    }
    info!("Starting {} watch stream...", resource_name);
    let stream = watcher(api, Default::default());
    tokio::pin!(stream);
    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => {
                use kube::runtime::watcher::Event;
                let (action, item_opt) = match event {
                    Event::Applied(item) => ("MODIFIED", Some(item)),
                    Event::Deleted(item) => ("DELETED", Some(item)),
                    Event::Restarted(items) => {
                        for item in items {
                            let item_data = serde_json::to_value(&item).unwrap_or_default();
                            if tx.send(ServerMessage::ResourceUpdate {
                                resource: resource_name.to_string(),
                                action: "MODIFIED".to_string(),
                                data: item_data,
                            })
                            .await
                            .is_err()
                            {
                                return;
                            }
                        }
                        continue;
                    }
                };
                if let Some(item) = item_opt {
                    let item_data = serde_json::to_value(&item).unwrap_or_default();
                    if tx.send(ServerMessage::ResourceUpdate {
                        resource: resource_name.to_string(),
                        action: action.to_string(),
                        data: item_data,
                    })
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
            }
            Err(e) => {
                error!("Watch error for {}: {}", resource_name, e);
                let _ = tx.send(ServerMessage::Error {
                    message: format!("Watch error: {}", e),
                })
                .await;
                return;
            }
        }
    }
}

async fn watch_mwcs(state: AppState, tx: tokio::sync::mpsc::Sender<ServerMessage>) {
    watch_dynamic_cluster_resource(state, tx, mwc_api_resource(), "mwc").await;
}

async fn watch_vwcs(state: AppState, tx: tokio::sync::mpsc::Sender<ServerMessage>) {
    watch_dynamic_cluster_resource(state, tx, vwc_api_resource(), "vwc").await;
}

async fn watch_custom_resources(
    state: AppState,
    tx: tokio::sync::mpsc::Sender<ServerMessage>,
    resource_name: &str,
    crd_name: &str,
) {
    let crd_api: Api<CustomResourceDefinition> = Api::all(state.kube_client().await);
    let crd = match crd_api.get(crd_name).await {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to fetch CRD {}: {}", crd_name, e);
            let _ = tx.send(ServerMessage::Error { message: format!("CRD not found: {}", crd_name) }).await;
            return;
        }
    };
    let spec = &crd.spec;
    let names = &spec.names;
    let storage_version = spec
        .versions
        .iter()
        .find(|v| v.storage)
        .or_else(|| spec.versions.first())
        .map(|v| v.name.clone())
        .unwrap_or_default();
    let gvk = GroupVersionKind::gvk(&spec.group, &storage_version, &names.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &names.plural);

    let api: Api<DynamicObject> = Api::all_with(state.kube_client().await, &ar);
    info!("Fetching initial custom resource list for {}...", resource_name);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            for item in list.items {
                let item_data = serde_json::to_value(&item).unwrap_or_default();
                if tx.send(ServerMessage::ResourceUpdate {
                    resource: resource_name.to_string(),
                    action: "ADDED".to_string(),
                    data: item_data,
                }).await.is_err() {
                    return;
                }
            }
        }
        Err(e) => {
            error!("Failed to list custom resources for {}: {}", crd_name, e);
            let _ = tx.send(ServerMessage::Error { message: format!("List failed: {}", e) }).await;
            return;
        }
    }
    info!("Starting custom resource watch stream for {}", resource_name);
    let stream = watcher(api, Default::default());
    tokio::pin!(stream);
    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => {
                use kube::runtime::watcher::Event;
                let (action, item_opt) = match event {
                    Event::Applied(item) => ("MODIFIED", Some(item)),
                    Event::Deleted(item) => ("DELETED", Some(item)),
                    Event::Restarted(items) => {
                        for item in items {
                            let item_data = serde_json::to_value(&item).unwrap_or_default();
                            if tx.send(ServerMessage::ResourceUpdate {
                                resource: resource_name.to_string(),
                                action: "MODIFIED".to_string(),
                                data: item_data,
                            }).await.is_err() {
                                return;
                            }
                        }
                        continue;
                    }
                };
                if let Some(item) = item_opt {
                    let item_data = serde_json::to_value(&item).unwrap_or_default();
                    if tx.send(ServerMessage::ResourceUpdate {
                        resource: resource_name.to_string(),
                        action: action.to_string(),
                        data: item_data,
                    }).await.is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                error!("Watch error for {}: {}", resource_name, e);
                let _ = tx.send(ServerMessage::Error { message: format!("Watch error: {}", e) }).await;
                break;
            }
        }
    }
}

