use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::Response,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Deserialize;
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
