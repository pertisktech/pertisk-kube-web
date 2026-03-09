//! WebTransport server for real-time K8s resource streaming.
//! Uses the same JSON protocol as the WebSocket handler (subscribe / resource_update).
//! Enable by setting WEBTRANSPORT_PORT (e.g. 4433). Requires HTTPS in production.

use crate::ws_handler::{spawn_watch_for_resource, ClientMessage, ServerMessage};
use crate::AppState;
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};
use uuid::Uuid;
use wtransport::endpoint::IncomingSession;
use wtransport::{Endpoint, Identity, ServerConfig};

const DEFAULT_READ_BUF_SIZE: usize = 65536;

/// Runs the WebTransport server loop. Bind to the given port with TLS.
/// Uses self-signed cert for the given hostnames if cert paths are not set.
pub async fn run_webtransport_server(
    state: AppState,
    port: u16,
    cert_path: Option<(String, String)>,
    hostnames: Vec<String>,
) -> anyhow::Result<()> {
    let identity = match cert_path {
        Some((cert, key)) => {
            Identity::load_pemfiles(&cert, &key)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to load TLS cert/key: {}", e))?
        }
        None => {
            let names: Vec<&str> = hostnames.iter().map(String::as_str).collect();
            Identity::self_signed(names).map_err(|e| anyhow::anyhow!("Self-signed cert failed: {}", e))?
        }
    };

    let config = ServerConfig::builder()
        .with_bind_default(port)
        .with_identity(identity)
        .build();

    let server = Endpoint::server(config)?;
    info!("WebTransport server listening on port {}", port);

    loop {
        let incoming_session = server.accept().await;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_wt_connection(incoming_session, state).await {
                warn!("WebTransport connection error: {}", e);
            }
        });
    }
}

async fn handle_wt_connection(
    incoming_session: IncomingSession,
    state: AppState,
) -> anyhow::Result<()> {
    let connection_id = Uuid::new_v4().to_string();
    info!("New WebTransport connection request");
    let session_request = incoming_session.await?;
    info!(
        "WebTransport connection established: {} (authority='{}', path='{}')",
        connection_id,
        session_request.authority(),
        session_request.path()
    );
    let connection = session_request.accept().await?;

    loop {
        let (send_stream, recv_stream) = connection.accept_bi().await?;
        let state = state.clone();
        let cid = connection_id.clone();

        tokio::spawn(async move {
            let mut buffer = vec![0u8; DEFAULT_READ_BUF_SIZE];
            if let Err(e) = handle_wt_stream(send_stream, recv_stream, state, &mut buffer, &cid).await {
                error!("WebTransport stream error (connection {}): {}", cid, e);
            }
        });
    }
}

async fn handle_wt_stream(
    mut send_stream: wtransport::stream::SendStream,
    mut recv_stream: wtransport::stream::RecvStream,
    state: AppState,
    buffer: &mut [u8],
    connection_id: &str,
) -> anyhow::Result<()> {
    // First message must be subscribe
    let n = recv_stream
        .read(buffer)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Stream closed before subscribe"))?;
    let text = std::str::from_utf8(&buffer[..n]).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {}", e))?;
    let client_msg: ClientMessage = serde_json::from_str(text.trim())
        .map_err(|e| anyhow::anyhow!("Invalid client message: {}", e))?;

    let resource = match &client_msg {
        ClientMessage::Subscribe { resource } => resource.clone(),
        _ => {
            let err = ServerMessage::Error {
                message: "First message must be subscribe".to_string(),
            };
            send_json(&mut send_stream, &err).await?;
            return Ok(());
        }
    };

    info!(
        "WebTransport subscribe: resource={} connection={}",
        resource, connection_id
    );

    let (tx, mut rx) = tokio::sync::mpsc::channel::<ServerMessage>(100);

    // Send Subscribed confirmation
    let subscribed = ServerMessage::Subscribed {
        resource: resource.clone(),
    };
    send_json(&mut send_stream, &subscribed).await?;

    spawn_watch_for_resource(state, tx, resource);

    // Forward watch messages to the stream (same task; SendStream is not cloneable)
    while let Some(msg) = rx.recv().await {
        if send_json(&mut send_stream, &msg).await.is_err() {
            break;
        }
    }

    Ok(())
}

async fn send_json(
    stream: &mut wtransport::stream::SendStream,
    msg: &ServerMessage,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(msg)?;
    let line = format!("{}\n", json);
    stream.write_all(line.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}
