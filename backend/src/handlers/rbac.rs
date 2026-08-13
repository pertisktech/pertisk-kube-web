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

pub async fn list_service_accounts(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::ServiceAccount;

    let api: Api<ServiceAccount> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<ServiceAccountItem> = list
                .items
                .into_iter()
                .map(|sa| {
                    let name = sa.metadata.name.unwrap_or_default();
                    let namespace = sa.metadata.namespace.unwrap_or_else(|| "default".into());

                    let secrets = sa
                        .secrets
                        .as_ref()
                        .map(|s| s.len())
                        .unwrap_or(0);

                    let age = sa
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = sa
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = sa
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    ServiceAccountItem {
                        name,
                        namespace,
                        secrets,
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
            error!("Error listing service accounts: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_roles(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::Role;

    let api: Api<Role> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<RoleItem> = list
                .items
                .into_iter()
                .map(|role| {
                    let name = role.metadata.name.unwrap_or_default();
                    let namespace = role.metadata.namespace.unwrap_or_else(|| "default".into());

                    let rules = role
                        .rules
                        .as_ref()
                        .map(|r| r.len())
                        .unwrap_or(0);

                    let age = role
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = role
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = role
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    RoleItem {
                        name,
                        namespace,
                        rules,
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
            error!("Error listing roles: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_role_bindings(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::RoleBinding;

    let api: Api<RoleBinding> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<RoleBindingItem> = list
                .items
                .into_iter()
                .map(|rb| {
                    let name = rb.metadata.name.unwrap_or_default();
                    let namespace = rb.metadata.namespace.unwrap_or_else(|| "default".into());

                    let role = format!("{}/{}", rb.role_ref.kind, rb.role_ref.name);

                    let subjects = rb
                        .subjects
                        .as_ref()
                        .map(|s| s.len())
                        .unwrap_or(0);

                    let age = rb
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = rb
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = rb
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    RoleBindingItem {
                        name,
                        namespace,
                        role,
                        subjects,
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
            error!("Error listing role bindings: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_cluster_roles(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRole;

    let api: Api<ClusterRole> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<ClusterRoleItem> = list
                .items
                .into_iter()
                .map(|cr| {
                    let name = cr.metadata.name.unwrap_or_default();

                    let rules = cr
                        .rules
                        .as_ref()
                        .map(|r| r.len())
                        .unwrap_or(0);

                    let age = cr
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = cr
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = cr
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    ClusterRoleItem {
                        name,
                        rules,
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
            error!("Error listing cluster roles: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_cluster_role_bindings(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRoleBinding;

    let api: Api<ClusterRoleBinding> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<ClusterRoleBindingItem> = list
                .items
                .into_iter()
                .map(|crb| {
                    let name = crb.metadata.name.unwrap_or_default();

                    let role = format!("{}/{}", crb.role_ref.kind, crb.role_ref.name);

                    let subjects = crb
                        .subjects
                        .as_ref()
                        .map(|s| s.len())
                        .unwrap_or(0);

                    let age = crb
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = crb
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = crb
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    ClusterRoleBindingItem {
                        name,
                        role,
                        subjects,
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
            error!("Error listing cluster role bindings: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_serviceaccount_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::ServiceAccount;

    let api: Api<ServiceAccount> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize serviceaccount to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting serviceaccount YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_serviceaccount_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::ServiceAccount;

    let mut obj: ServiceAccount = match serde_yaml::from_str(&body) {
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

    let api: Api<ServiceAccount> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting serviceaccount YAML to JSON {}/{}: {:?}",
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
                "message": "ServiceAccount updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating serviceaccount YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update serviceaccount: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_serviceaccount(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::ServiceAccount;
    let api: Api<ServiceAccount> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted serviceaccount {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting serviceaccount {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_role_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::Role;

    let api: Api<Role> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize role to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting role YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_role_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::Role;

    let mut obj: Role = match serde_yaml::from_str(&body) {
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

    let api: Api<Role> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting role YAML to JSON {}/{}: {:?}",
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
                "message": "Role updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating role YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update role: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_role(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::Role;
    let api: Api<Role> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted role {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting role {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_rolebinding_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::RoleBinding;

    let api: Api<RoleBinding> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize rolebinding to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting rolebinding YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_rolebinding_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::RoleBinding;

    let mut obj: RoleBinding = match serde_yaml::from_str(&body) {
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

    let api: Api<RoleBinding> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting rolebinding YAML to JSON {}/{}: {:?}",
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
                "message": "RoleBinding updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating rolebinding YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update rolebinding: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_rolebinding(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::RoleBinding;
    let api: Api<RoleBinding> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted rolebinding {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting rolebinding {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_clusterrole_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRole;

    let api: Api<ClusterRole> = Api::all(state.kube_client().await);
    match api.get(&name).await {
        Ok(obj) => match serde_yaml::to_string(&obj) {
            Ok(yaml) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
                yaml,
            )
                .into_response(),
            Err(err) => {
                error!("Failed to serialize clusterrole to YAML {}: {:?}", name, err);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting clusterrole YAML {}: {:?}", name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_clusterrole_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRole;

    let mut obj: ClusterRole = match serde_yaml::from_str(&body) {
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

    let api: Api<ClusterRole> = Api::all(state.kube_client().await);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!("Failed converting clusterrole YAML to JSON {}: {:?}", name, err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let patch_params = PatchParams::apply("pertisk-kube-web").force();
    match api.patch(&name, &patch_params, &Patch::Apply(patch_value)).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "message": "ClusterRole updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating clusterrole YAML {}: {:?}", name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update clusterrole: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_clusterrole(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRole;
    let api: Api<ClusterRole> = Api::all(state.kube_client().await);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted clusterrole {}", name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting clusterrole {}: {:?}", name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_clusterrolebinding_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRoleBinding;

    let api: Api<ClusterRoleBinding> = Api::all(state.kube_client().await);
    match api.get(&name).await {
        Ok(obj) => match serde_yaml::to_string(&obj) {
            Ok(yaml) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
                yaml,
            )
                .into_response(),
            Err(err) => {
                error!("Failed to serialize clusterrolebinding to YAML {}: {:?}", name, err);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting clusterrolebinding YAML {}: {:?}", name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_clusterrolebinding_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRoleBinding;

    let mut obj: ClusterRoleBinding = match serde_yaml::from_str(&body) {
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

    let api: Api<ClusterRoleBinding> = Api::all(state.kube_client().await);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!("Failed converting clusterrolebinding YAML to JSON {}: {:?}", name, err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let patch_params = PatchParams::apply("pertisk-kube-web").force();
    match api.patch(&name, &patch_params, &Patch::Apply(patch_value)).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "message": "ClusterRoleBinding updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating clusterrolebinding YAML {}: {:?}", name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update clusterrolebinding: {}", err),
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_clusterrolebinding(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::rbac::v1::ClusterRoleBinding;
    let api: Api<ClusterRoleBinding> = Api::all(state.kube_client().await);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted clusterrolebinding {}", name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting clusterrolebinding {}: {:?}", name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
