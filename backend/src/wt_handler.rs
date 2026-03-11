//! WebTransport server for real-time K8s resource streaming.
//! Uses the same JSON protocol as the WebSocket handler (subscribe / resource_update).
//! Enable by setting WEBTRANSPORT_PORT (e.g. 4433). Requires HTTPS in production.

use crate::ws_handler::{spawn_watch_for_resource, ClientMessage, ServerMessage};
use crate::AppState;
use rustls_pemfile::certs;
use sha2::{Digest, Sha256};
use std::io::BufReader;
use std::net::SocketAddr;
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};
use uuid::Uuid;
use wtransport::endpoint::IncomingSession;
use wtransport::{Endpoint, Identity, ServerConfig};

const DEFAULT_READ_BUF_SIZE: usize = 65536;

/// SHA-256 hash of the first certificate in the PEM file (leaf cert). Used for serverCertificateHashes
/// so the frontend can pin the exact cert we serve. Prefer this over cert_hash_from_identity when
/// loading from PEM so the hash always matches what the TLS stack presents.
pub fn cert_hash_from_pem_file(cert_path: &str) -> Option<Vec<u8>> {
    let file = std::fs::File::open(cert_path).ok()?;
    let mut reader = BufReader::new(file);
    let chain = certs(&mut reader).collect::<Result<Vec<_>, _>>().ok()?;
    let first_der = chain.into_iter().next()?;
    Some(Sha256::digest(&first_der).to_vec())
}

/// Create WebTransport TLS identity from PEM files or self-signed for hostnames.
pub async fn create_webtransport_identity(
    cert_path: Option<(String, String)>,
    hostnames: &[String],
) -> anyhow::Result<Identity> {
    match cert_path {
        Some((cert, key)) => Identity::load_pemfiles(&cert, &key)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to load TLS cert/key: {}", e)),
        None => {
            let names: Vec<&str> = hostnames.iter().map(String::as_str).collect();
            Identity::self_signed(names).map_err(|e| anyhow::anyhow!("Self-signed cert failed: {}", e))
        }
    }
}

/// Raw SHA-256 (32 bytes) of the first cert in the chain, for serverCertificateHashes (sent as JSON array like pertisk-web-transport).
pub fn cert_hash_from_identity(identity: &Identity) -> Option<Vec<u8>> {
    identity
        .certificate_chain()
        .as_slice()
        .first()
        .map(|cert| cert.hash().as_ref().to_vec())
}

/// Runs the WebTransport server loop. Binds to 0.0.0.0:port so the port is visible (e.g. netstat/lsof).
/// Identity and cert hash must be set in main before spawning so /api/config has the hash.
pub async fn run_webtransport_server(
    state: AppState,
    port: u16,
    identity: Identity,
) -> anyhow::Result<()> {
    let bind_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let config = ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_identity(identity)
        .build();

    let server = Endpoint::server(config)?;
    let bound = server.local_addr().unwrap_or(bind_addr);
    info!("WebTransport server listening on {}", bound);

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
