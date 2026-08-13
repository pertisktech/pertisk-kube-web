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

pub async fn list_services(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Service;

    let api: Api<Service> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<ServiceItem> = list
                .items
                .into_iter()
                .map(|svc| {
                    let name = svc.metadata.name.unwrap_or_default();
                    let namespace = svc.metadata.namespace.unwrap_or_else(|| "default".into());
                    let spec = svc.spec.as_ref();
                    let status = svc.status.as_ref();

                    let service_type = spec
                        .and_then(|s| s.type_.clone())
                        .unwrap_or_else(|| "ClusterIP".into());

                    let cluster_ip = spec
                        .and_then(|s| s.cluster_ip.clone())
                        .unwrap_or_else(|| "-".into());

                    let mut external_values: Vec<String> = spec
                        .and_then(|s| s.external_ips.clone())
                        .unwrap_or_default();

                    if let Some(lb_ingress) = status
                        .and_then(|s| s.load_balancer.as_ref())
                        .and_then(|lb| lb.ingress.as_ref())
                    {
                        external_values.extend(lb_ingress.iter().map(|entry| {
                            entry
                                .ip
                                .clone()
                                .or_else(|| entry.hostname.clone())
                                .unwrap_or_else(|| "-".into())
                        }));
                    }

                    external_values.retain(|value| value != "-");
                    external_values.sort();
                    external_values.dedup();

                    let external_ip = if external_values.is_empty() {
                        "-".into()
                    } else {
                        external_values.join(", ")
                    };

                    let ports = spec
                        .and_then(|s| s.ports.clone())
                        .map(|values| {
                            let rendered: Vec<String> = values
                                .into_iter()
                                .map(|port| format!("{}/{}", port.port, port.protocol.unwrap_or_else(|| "TCP".into())))
                                .collect();
                            if rendered.is_empty() {
                                "-".into()
                            } else {
                                rendered.join(", ")
                            }
                        })
                        .unwrap_or_else(|| "-".into());

                    let age = svc
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = svc
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = svc
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    ServiceItem {
                        name,
                        namespace,
                        service_type,
                        cluster_ip,
                        external_ip,
                        ports,
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
            error!("Error listing services: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_endpoints(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Endpoints;

    let api: Api<Endpoints> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<EndpointItem> = list
                .items
                .into_iter()
                .map(|ep| {
                    let name = ep.metadata.name.unwrap_or_default();
                    let namespace = ep.metadata.namespace.unwrap_or_else(|| "default".into());

                    let subsets = ep.subsets.unwrap_or_default();
                    let addresses = subsets
                        .iter()
                        .map(|subset| subset.addresses.as_ref().map_or(0, |a| a.len()))
                        .sum();
                    let not_ready = subsets
                        .iter()
                        .map(|subset| subset.not_ready_addresses.as_ref().map_or(0, |a| a.len()))
                        .sum();

                    let mut unique_ports: Vec<String> = subsets
                        .iter()
                        .flat_map(|subset| {
                            subset
                                .ports
                                .as_ref()
                                .map(|ports| {
                                    ports
                                        .iter()
                                        .map(|port| format!("{}/{}", port.port, port.protocol.clone().unwrap_or_else(|| "TCP".into())))
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default()
                        })
                        .collect();
                    unique_ports.sort();
                    unique_ports.dedup();

                    let ports = if unique_ports.is_empty() {
                        "-".into()
                    } else {
                        unique_ports.join(", ")
                    };

                    let age = ep
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = ep
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = ep
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    EndpointItem {
                        name,
                        namespace,
                        addresses,
                        not_ready,
                        ports,
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
            error!("Error listing endpoints: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_ingresses(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::Ingress;

    let api: Api<Ingress> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<IngressItem> = list
                .items
                .into_iter()
                .map(|ing| {
                    let name = ing.metadata.name.unwrap_or_default();
                    let namespace = ing.metadata.namespace.unwrap_or_else(|| "default".into());
                    let spec = ing.spec.as_ref();
                    let status = ing.status.as_ref();

                    let ingress_class = spec
                        .and_then(|s| s.ingress_class_name.clone())
                        .unwrap_or_else(|| "-".into());

                    let rules = spec
                        .and_then(|s| s.rules.as_ref())
                        .map_or(0, |values| values.len());

                    let mut hosts: Vec<String> = spec
                        .and_then(|s| s.rules.as_ref())
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|rule| rule.host.clone())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    hosts.sort();
                    hosts.dedup();
                    let hosts = if hosts.is_empty() {
                        "-".into()
                    } else {
                        hosts.join(", ")
                    };

                    let mut addresses: Vec<String> = status
                        .and_then(|s| s.load_balancer.as_ref())
                        .and_then(|lb| lb.ingress.as_ref())
                        .map(|entries| {
                            entries
                                .iter()
                                .map(|entry| {
                                    entry
                                        .ip
                                        .clone()
                                        .or_else(|| entry.hostname.clone())
                                        .unwrap_or_else(|| "-".into())
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    addresses.retain(|value| value != "-");
                    addresses.sort();
                    addresses.dedup();
                    let address = if addresses.is_empty() {
                        "-".into()
                    } else {
                        addresses.join(", ")
                    };

                    let age = ing
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = ing
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = ing
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    IngressItem {
                        name,
                        namespace,
                        ingress_class,
                        hosts,
                        address,
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
            error!("Error listing ingresses: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_ingressclasses(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::IngressClass;

    let api: Api<IngressClass> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<IngressClassItem> = list
                .items
                .into_iter()
                .map(|ing_class| {
                    let name = ing_class.metadata.name.unwrap_or_default();
                    let controller = ing_class
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.controller.clone())
                        .unwrap_or_else(|| "-".into());
                    let parameters = ing_class
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.parameters.as_ref())
                        .as_ref()
                        .map(|params| format!("{}/{}", params.kind, params.name))
                        .unwrap_or_else(|| "-".into());

                    let is_default = ing_class
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|annotations| annotations.get("ingressclass.kubernetes.io/is-default-class"))
                        .map(|value| value == "true")
                        .unwrap_or(false);

                    let age = ing_class
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = ing_class
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = ing_class
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    IngressClassItem {
                        name,
                        controller,
                        is_default,
                        parameters,
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
            error!("Error listing ingress classes: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_networkpolicies(State(state): State<AppState>) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::NetworkPolicy;

    let api: Api<NetworkPolicy> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<NetworkPolicyItem> = list
                .items
                .into_iter()
                .map(|policy| {
                    let name = policy.metadata.name.unwrap_or_default();
                    let namespace = policy.metadata.namespace.unwrap_or_else(|| "default".into());

                    let selector_labels = policy
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.pod_selector.match_labels.as_ref())
                        .as_ref()
                        .map(|labels| {
                            let mut rendered: Vec<String> = labels
                                .iter()
                                .map(|(key, value)| format!("{}={}", key, value))
                                .collect();
                            rendered.sort();
                            if rendered.is_empty() {
                                "All pods".into()
                            } else {
                                rendered.join(", ")
                            }
                        })
                        .unwrap_or_else(|| "All pods".into());

                    let policy_types = policy
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.policy_types.clone())
                        .unwrap_or_default()
                        .join(", ");

                    let ingress_rules = policy
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.ingress.as_ref())
                        .map_or(0, |rules| rules.len());
                    let egress_rules = policy
                        .spec
                        .as_ref()
                        .and_then(|spec| spec.egress.as_ref())
                        .map_or(0, |rules| rules.len());

                    let age = policy
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                        .unwrap_or_default();

                    let labels = policy
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|l| serde_json::to_value(l).ok())
                        .and_then(|v| v.as_object().cloned());
                    let annotations = policy
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| serde_json::to_value(a).ok())
                        .and_then(|v| v.as_object().cloned());

                    NetworkPolicyItem {
                        name,
                        namespace,
                        pod_selector: selector_labels,
                        policy_types,
                        ingress_rules,
                        egress_rules,
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
            error!("Error listing network policies: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn get_service_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Service;

    let api: Api<Service> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize service to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting service YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_service_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Service;

    let mut obj: Service = match serde_yaml::from_str(&body) {
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

    let api: Api<Service> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting service YAML to JSON {}/{}: {:?}",
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
                "message": "Service updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating service YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update service: {}", err)
                })),
            )
                .into_response()
        }
    }
}

pub async fn get_endpoint_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Endpoints;

    let api: Api<Endpoints> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize endpoint to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting endpoint YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_endpoint_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Endpoints;

    let mut obj: Endpoints = match serde_yaml::from_str(&body) {
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

    let api: Api<Endpoints> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting endpoint YAML to JSON {}/{}: {:?}",
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
                "message": "Endpoint updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating endpoint YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update endpoint: {}", err)
                })),
            )
                .into_response()
        }
    }
}

pub async fn get_ingress_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::Ingress;

    let api: Api<Ingress> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize ingress to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting ingress YAML {}/{}: {:?}", namespace, name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_ingress_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::Ingress;

    let mut obj: Ingress = match serde_yaml::from_str(&body) {
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

    let api: Api<Ingress> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting ingress YAML to JSON {}/{}: {:?}",
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
                "message": "Ingress updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating ingress YAML {}/{}: {:?}", namespace, name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update ingress: {}", err)
                })),
            )
                .into_response()
        }
    }
}

pub async fn get_ingressclass_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::IngressClass;

    let api: Api<IngressClass> = Api::all(state.kube_client().await);
    match api.get(&name).await {
        Ok(obj) => match serde_yaml::to_string(&obj) {
            Ok(yaml) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
                yaml,
            )
                .into_response(),
            Err(err) => {
                error!("Failed to serialize ingressclass to YAML {}: {:?}", name, err);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!("Error getting ingressclass YAML {}: {:?}", name, err);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_ingressclass_yaml(
    Path(name): Path<String>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::IngressClass;

    let mut obj: IngressClass = match serde_yaml::from_str(&body) {
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

    let api: Api<IngressClass> = Api::all(state.kube_client().await);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!("Failed converting ingressclass YAML to JSON {}: {:?}", name, err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let patch_params = PatchParams::apply("pertisk-kube-web").force();
    match api.patch(&name, &patch_params, &Patch::Apply(patch_value)).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "message": "IngressClass updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!("Error updating ingressclass YAML {}: {:?}", name, err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update ingressclass: {}", err)
                })),
            )
                .into_response()
        }
    }
}

pub async fn get_networkpolicy_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::NetworkPolicy;

    let api: Api<NetworkPolicy> = Api::namespaced(state.kube_client().await, &namespace);
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
                    "Failed to serialize networkpolicy to YAML {}/{}: {:?}",
                    namespace, name, err
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(err) => {
            error!(
                "Error getting networkpolicy YAML {}/{}: {:?}",
                namespace, name, err
            );
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub async fn update_networkpolicy_yaml(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: String,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::NetworkPolicy;

    let mut obj: NetworkPolicy = match serde_yaml::from_str(&body) {
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

    let api: Api<NetworkPolicy> = Api::namespaced(state.kube_client().await, &namespace);
    let patch_value = match serde_json::to_value(&obj) {
        Ok(v) => v,
        Err(err) => {
            error!(
                "Failed converting networkpolicy YAML to JSON {}/{}: {:?}",
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
                "message": "NetworkPolicy updated successfully"
            })),
        )
            .into_response(),
        Err(err) => {
            error!(
                "Error updating networkpolicy YAML {}/{}: {:?}",
                namespace, name, err
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "success": false,
                    "message": format!("Failed to update networkpolicy: {}", err)
                })),
            )
                .into_response()
        }
    }
}

pub async fn delete_service(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Service;

    let api: Api<Service> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted service {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting service {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_endpoint(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::core::v1::Endpoints;

    let api: Api<Endpoints> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted endpoint {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting endpoint {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_ingress(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::Ingress;

    let api: Api<Ingress> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted ingress {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting ingress {}/{}: {:?}", namespace, name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_ingressclass(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::IngressClass;

    let api: Api<IngressClass> = Api::all(state.kube_client().await);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted ingressclass {}", name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!("Error deleting ingressclass {}: {:?}", name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_networkpolicy(
    Path((namespace, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    use k8s_openapi::api::networking::v1::NetworkPolicy;

    let api: Api<NetworkPolicy> = Api::namespaced(state.kube_client().await, &namespace);
    match api.delete(&name, &DeleteParams::default()).await {
        Ok(_) => {
            info!("Deleted networkpolicy {}/{}", namespace, name);
            (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
        }
        Err(err) => {
            error!(
                "Error deleting networkpolicy {}/{}: {:?}",
                namespace, name, err
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
