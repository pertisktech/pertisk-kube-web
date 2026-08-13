use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tracing::{error, info};

use crate::utils::{
    build_client_from_kubeconfig_path, default_kubeconfig_path, list_kubeconfig_contexts_from_path,
};
use crate::AppState;

#[derive(Serialize)]
pub struct ClusterStatusResponse {
    pub ok: bool,
    pub placeholder: bool,
    pub message: Option<String>,
    pub kubeconfig_path: String,
    pub context: Option<String>,
    pub contexts: Vec<String>,
}

#[derive(Deserialize)]
pub struct UploadKubeconfigRequest {
    /// Raw kubeconfig YAML content.
    pub content: String,
    /// Optional context to activate after upload.
    pub context: Option<String>,
}

#[derive(Deserialize)]
pub struct SelectClusterRequest {
    pub context: String,
}

fn persisted_kubeconfig_path() -> PathBuf {
    default_kubeconfig_path()
}

fn ensure_parent_dir(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    Ok(())
}

async fn apply_client(
    state: &AppState,
    client: kube::Client,
    context: String,
    path: &PathBuf,
) {
    *state.client.write().await = client;
    state.auth_placeholder.store(false, Ordering::Relaxed);
    *state.auth_message.write().await = None;
    *state.current_context.write().await = Some(context.clone());
    *state.kubeconfig_path.write().await = path.display().to_string();
    info!(
        "Kubernetes client connected using {} (context '{}')",
        path.display(),
        context
    );
}

pub async fn cluster_status(State(state): State<AppState>) -> impl IntoResponse {
    let path = persisted_kubeconfig_path();
    let (contexts, current) = if path.exists() {
        list_kubeconfig_contexts_from_path(&path).unwrap_or_default()
    } else {
        (Vec::new(), None)
    };

    let selected = state.current_context.read().await.clone().or(current);
    let placeholder = state.is_auth_placeholder();
    let message = if placeholder {
        Some(
            state
                .auth_user_message()
                .await
                .unwrap_or_else(|| "Upload a kubeconfig to connect to a cluster.".to_string()),
        )
    } else {
        None
    };

    (
        StatusCode::OK,
        Json(ClusterStatusResponse {
            ok: !placeholder,
            placeholder,
            message,
            kubeconfig_path: path.display().to_string(),
            context: selected,
            contexts,
        }),
    )
}

pub async fn upload_kubeconfig(
    State(state): State<AppState>,
    Json(payload): Json<UploadKubeconfigRequest>,
) -> impl IntoResponse {
    let content = payload.content.trim();
    if content.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": "kubeconfig content is empty",
            })),
        )
            .into_response();
    }

    let path = persisted_kubeconfig_path();
    if let Err(err) = ensure_parent_dir(&path) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "success": false, "message": err })),
        )
            .into_response();
    }

    if let Err(err) = fs::write(&path, content) {
        error!("Failed to write kubeconfig {}: {}", path.display(), err);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "message": format!("failed to write kubeconfig: {err}"),
            })),
        )
            .into_response();
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o640));
    }

    // Make subsequent client loads find this file.
    std::env::set_var("KUBECONFIG", path.display().to_string());

    match build_client_from_kubeconfig_path(&path, payload.context.as_deref()).await {
        Ok((client, context)) => {
            apply_client(&state, client, context.clone(), &path).await;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "message": format!("Connected using context '{}'", context),
                    "context": context,
                    "kubeconfig_path": path.display().to_string(),
                })),
            )
                .into_response()
        }
        Err(err) => {
            error!("Failed to load uploaded kubeconfig: {}", err);
            state.auth_placeholder.store(true, Ordering::Relaxed);
            *state.auth_message.write().await = Some(err.to_string());
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "success": false,
                    "message": err.to_string(),
                })),
            )
                .into_response()
        }
    }
}

pub async fn select_cluster_context(
    State(state): State<AppState>,
    Json(payload): Json<SelectClusterRequest>,
) -> impl IntoResponse {
    let context = payload.context.trim().to_string();
    if context.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": "context is required",
            })),
        )
            .into_response();
    }

    let path = persisted_kubeconfig_path();
    if !path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": format!("kubeconfig not found at {}", path.display()),
            })),
        )
            .into_response();
    }

    std::env::set_var("KUBECONFIG", path.display().to_string());
    std::env::set_var("KUBE_CONTEXT", &context);

    match build_client_from_kubeconfig_path(&path, Some(&context)).await {
        Ok((client, selected)) => {
            apply_client(&state, client, selected.clone(), &path).await;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "message": format!("Switched to context '{}'", selected),
                    "context": selected,
                })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": err.to_string(),
            })),
        )
            .into_response(),
    }
}
