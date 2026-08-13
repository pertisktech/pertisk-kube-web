use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use kube::{api::{DeleteParams, ListParams, Patch, PatchParams}, Api};
use tracing::{error, info};

use crate::models::*;
use crate::AppState;

pub async fn list_persistent_volumes(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolume;

    let api: Api<PersistentVolume> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<PersistentVolumeItem> = list
                .items
                .into_iter()
                .map(|pv| {
                    let name = pv.metadata.name.unwrap_or_default();
                    
                    let capacity = pv
                        .spec
                        .as_ref()
                        .and_then(|s| s.capacity.as_ref())
                        .and_then(|c| c.get("storage"))
                        .map(|q| q.0.clone())
                        .unwrap_or_else(|| "-".into());

                    let access_modes = pv
                        .spec
                        .as_ref()
                        .and_then(|s| s.access_modes.as_ref())
                        .map(|modes| modes.join(", "))
                        .unwrap_or_else(|| "-".into());

                    let reclaim_policy = pv
                        .spec
                        .as_ref()
                        .and_then(|s| s.persistent_volume_reclaim_policy.clone())
                        .unwrap_or_else(|| "-".into());

                    let status = pv
                        .status
                        .as_ref()
                        .and_then(|s| s.phase.clone())
                        .unwrap_or_else(|| "Unknown".into());

                    let claim = pv
                        .spec
                        .as_ref()
                        .and_then(|s| s.claim_ref.as_ref())
                        .map(|c| {
                            format!(
                                "{}/{}",
                                c.namespace.clone().unwrap_or_default(),
                                c.name.clone().unwrap_or_default()
                            )
                        })
                        .unwrap_or_else(|| "-".into());

                    let storage_class = pv
                        .spec
                        .as_ref()
                        .and_then(|s| s.storage_class_name.clone())
                        .unwrap_or_else(|| "-".into());

                    let age = pv
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = pv
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = pv
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    PersistentVolumeItem {
                        name,
                        capacity,
                        access_modes,
                        reclaim_policy,
                        status,
                        claim,
                        storage_class,
                        age,
                        labels,
                        annotations,
                    }
                })
                .collect();

            let total = items.len();
            (StatusCode::OK, Json(ApiResponse { data: items, total })).into_response()
        }
        Err(err) => {
            error!("Error listing persistent volumes: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_persistent_volume_claims(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolumeClaim;

    let api: Api<PersistentVolumeClaim> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<PersistentVolumeClaimItem> = list
                .items
                .into_iter()
                .map(|pvc| {
                    let name = pvc.metadata.name.unwrap_or_default();
                    let namespace = pvc.metadata.namespace.unwrap_or_else(|| "default".into());

                    let status = pvc
                        .status
                        .as_ref()
                        .and_then(|s| s.phase.clone())
                        .unwrap_or_else(|| "Unknown".into());

                    let volume = pvc
                        .spec
                        .as_ref()
                        .and_then(|s| s.volume_name.clone())
                        .unwrap_or_else(|| "-".into());

                    let capacity = pvc
                        .status
                        .as_ref()
                        .and_then(|s| s.capacity.as_ref())
                        .and_then(|c| c.get("storage"))
                        .map(|q| q.0.clone())
                        .unwrap_or_else(|| "-".into());

                    let access_modes = pvc
                        .spec
                        .as_ref()
                        .and_then(|s| s.access_modes.as_ref())
                        .map(|modes| modes.join(", "))
                        .unwrap_or_else(|| "-".into());

                    let storage_class = pvc
                        .spec
                        .as_ref()
                        .and_then(|s| s.storage_class_name.clone())
                        .unwrap_or_else(|| "-".into());

                    let age = pvc
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = pvc
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = pvc
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    PersistentVolumeClaimItem {
                        name,
                        namespace,
                        status,
                        volume,
                        capacity,
                        access_modes,
                        storage_class,
                        age,
                        labels,
                        annotations,
                    }
                })
                .collect();

            let total = items.len();
            (StatusCode::OK, Json(ApiResponse { data: items, total })).into_response()
        }
        Err(err) => {
            error!("Error listing persistent volume claims: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_storage_classes(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::storage::v1::StorageClass;

    let api: Api<StorageClass> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<StorageClassItem> = list
                .items
                .into_iter()
                .map(|sc| {
                    let name = sc.metadata.name.unwrap_or_default();
                    let provisioner = sc.provisioner.clone();

                    let reclaim_policy = sc
                        .reclaim_policy
                        .clone()
                        .unwrap_or_else(|| "-".into());

                    let volume_binding_mode = sc
                        .volume_binding_mode
                        .clone()
                        .unwrap_or_else(|| "-".into());

                    let allow_volume_expansion = sc.allow_volume_expansion.unwrap_or(false);

                    let is_default = sc
                        .metadata
                        .annotations
                        .as_ref()
                        .map(|a| {
                            a.get("storageclass.kubernetes.io/is-default-class")
                                .map(|v| v == "true")
                                .unwrap_or(false)
                                || a.get("storageclass.beta.kubernetes.io/is-default-class")
                                    .map(|v| v == "true")
                                    .unwrap_or(false)
                        })
                        .unwrap_or(false);

                    let age = sc
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = sc
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = sc
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    StorageClassItem {
                        name,
                        provisioner,
                        reclaim_policy,
                        volume_binding_mode,
                        allow_volume_expansion,
                        is_default,
                        age,
                        labels,
                        annotations,
                    }
                })
                .collect();

            let total = items.len();
            (StatusCode::OK, Json(ApiResponse { data: items, total })).into_response()
        }
        Err(err) => {
            error!("Error listing storage classes: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_persistentvolume_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolume;

    let api: Api<PersistentVolume> = Api::all(state.kube_client().await);
    match api.get(&name).await {
        Ok(obj) => match serde_yaml::to_string(&obj) {
            Ok(yaml) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
                yaml,
            )
                .into_response(),
            Err(err) => {
                error!("Failed to serialize persistentvolume to YAML {}: {:?}", name, err);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting persistentvolume YAML {}: {:?}", name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_persistentvolume_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolume;

    let mut obj: PersistentVolume = match serde_yaml::from_str(&body) {
        Ok(o) => o,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Invalid YAML: {}", err),
                })),
            )
                .into_response();
        }
    };

    obj.metadata.name = Some(name.clone());

    let api: Api<PersistentVolume> = Api::all(state.kube_client().await);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!("Failed converting persistentvolume YAML to JSON {}: {:?}", name, err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let patch_params = PatchParams::apply("pertisk-kube-web").force();
    match api.patch(&name, &patch_params, &Patch::Apply(patch_value)).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "message": "PersistentVolume updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating persistentvolume YAML {}: {:?}", name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update persistentvolume: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_persistentvolume(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolume;
    let api: Api<PersistentVolume> = Api::all(state.kube_client().await);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted persistentvolume {}", name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting persistentvolume {}: {:?}", name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_persistentvolumeclaim_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolumeClaim;

    let api: Api<PersistentVolumeClaim> = Api::namespaced(state.kube_client().await, &namespace);
    match api.get(&name).await {
        Ok(obj) => match serde_yaml::to_string(&obj) {
            Ok(yaml) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
                yaml,
            )
                .into_response(),
            Err(err) => {
                error!(
                    "Failed to serialize persistentvolumeclaim to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting persistentvolumeclaim YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_persistentvolumeclaim_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolumeClaim;

    let mut obj: PersistentVolumeClaim = match serde_yaml::from_str(&body) {
        Ok(o) => o,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Invalid YAML: {}", err),
                })),
            )
                .into_response();
        }
    };

    obj.metadata.name = Some(name.clone());
    obj.metadata.namespace = Some(namespace.clone());

    let api: Api<PersistentVolumeClaim> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting persistentvolumeclaim YAML to JSON {}/{}: {:?}",
                namespace, name, err
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let patch_params = PatchParams::apply("pertisk-kube-web").force();
    match api.patch(&name, &patch_params, &Patch::Apply(patch_value)).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "message": "PersistentVolumeClaim updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating persistentvolumeclaim YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update persistentvolumeclaim: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_persistentvolumeclaim(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::PersistentVolumeClaim;
    let api: Api<PersistentVolumeClaim> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted persistentvolumeclaim {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting persistentvolumeclaim {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_storageclass_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::storage::v1::StorageClass;

    let api: Api<StorageClass> = Api::all(state.kube_client().await);
    match api.get(&name).await {
        Ok(obj) => match serde_yaml::to_string(&obj) {
            Ok(yaml) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
                yaml,
            )
                .into_response(),
            Err(err) => {
                error!("Failed to serialize storageclass to YAML {}: {:?}", name, err);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting storageclass YAML {}: {:?}", name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_storageclass_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::storage::v1::StorageClass;

    let mut obj: StorageClass = match serde_yaml::from_str(&body) {
        Ok(o) => o,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Invalid YAML: {}", err),
                })),
            )
                .into_response();
        }
    };

    obj.metadata.name = Some(name.clone());

    let api: Api<StorageClass> = Api::all(state.kube_client().await);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!("Failed converting storageclass YAML to JSON {}: {:?}", name, err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let patch_params = PatchParams::apply("pertisk-kube-web").force();
    match api.patch(&name, &patch_params, &Patch::Apply(patch_value)).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "message": "StorageClass updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating storageclass YAML {}: {:?}", name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update storageclass: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_storageclass(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::storage::v1::StorageClass;
    let api: Api<StorageClass> = Api::all(state.kube_client().await);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted storageclass {}", name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting storageclass {}: {:?}", name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
