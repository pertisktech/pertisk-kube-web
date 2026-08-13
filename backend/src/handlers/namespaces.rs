use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use kube::{api::{DeleteParams, ListParams}, Api};
use tracing::{error, info};

use crate::models::*;
use crate::AppState;

pub async fn list_namespaces(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Namespace;

    let api: Api<Namespace> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<NamespaceItem> = list
                .items
                .into_iter()
                .filter_map(|ns| {
                    ns.metadata.name.map(|name| NamespaceItem {
                        name,
                        phase: ns
                            .status
                            .as_ref()
                            .and_then(|s| s.phase.clone())
                            .unwrap_or_else(|| "Unknown".into()),
                        labels: ns
                            .metadata
                            .labels
                            .as_ref()
                            .map(|labels| {
                                let mut pairs: Vec<String> = labels
                                    .iter()
                                    .map(|(key, value)| format!("{}={}", key, value))
                                    .collect();
                                pairs.sort();
                                if pairs.is_empty() {
                                    "-".to_string()
                                } else {
                                    pairs.join(", ")
                                }
                            })
                            .unwrap_or_else(|| "-".to_string()),
                        age: ns
                            .metadata
                            .creation_timestamp
                            .as_ref()
                            .map(|t| t.0.to_rfc3339())
                            .unwrap_or_default(),
                    })
                })
                .collect();
            let total = items.len();
            (StatusCode::OK, Json(ApiResponse { data: items, total })).into_response()
        }
        Err(err) => {
            error!("Error listing namespaces: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_namespace(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Namespace;
    let api: Api<Namespace> = Api::all(state.kube_client().await);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted namespace {}", name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting namespace {}: {:?}", name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
