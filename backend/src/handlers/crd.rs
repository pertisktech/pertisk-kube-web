use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::{
    api::{ApiResource, DeleteParams, DynamicObject, GroupVersionKind, ListParams},
    Api,
};
use serde::Deserialize;
use tracing::error;

use crate::models::*;
use crate::AppState;

fn custom_resource_from_dynamic(obj: DynamicObject) -> CustomResourceItem {
    let labels = obj
        .metadata
        .labels
        .as_ref()
        .map(|bt| bt.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<HashMap<_, _>>());
    let annotations = obj
        .metadata
        .annotations
        .as_ref()
        .map(|bt| bt.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<HashMap<_, _>>());
    CustomResourceItem {
        name: obj.metadata.name.unwrap_or_default(),
        namespace: obj.metadata.namespace,
        created_at: obj
            .metadata
            .creation_timestamp
            .map(|t| t.0.to_rfc3339()),
        spec: obj.data.get("spec").cloned().unwrap_or(serde_json::Value::Null),
        status: obj.data.get("status").cloned(),
        labels,
        annotations,
    }
}

#[derive(Deserialize)]
pub struct NamespaceQuery {
    pub namespace: Option<String>,
}

pub async fn list_crds(State(state): State<AppState>) -> impl IntoResponse {
    let api: Api<CustomResourceDefinition> = Api::all(state.kube_client().await);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let items: Vec<CrdItem> = list
                .items
                .iter()
                .map(|crd| {
                    let meta = &crd.metadata;
                    let spec = &crd.spec;
                    let names = &spec.names;
                    let storage_version = spec
                        .versions
                        .iter()
                        .find(|v| v.storage)
                        .or_else(|| spec.versions.first());
                    let printer_columns = storage_version
                        .and_then(|v| v.additional_printer_columns.as_ref())
                        .map(|cols| {
                            cols.iter()
                                .filter(|c| !c.json_path.is_empty() && !c.name.eq_ignore_ascii_case("age"))
                                .map(|c| CrdPrinterColumnItem {
                                    name: c.name.clone(),
                                    json_path: c.json_path.clone(),
                                    type_: Some(c.type_.clone()),
                                    priority: c.priority,
                                })
                                .collect::<Vec<_>>()
                        })
                        .filter(|v| !v.is_empty());

                    CrdItem {
                        name: meta.name.clone().unwrap_or_default(),
                        group: spec.group.clone(),
                        scope: spec.scope.clone(),
                        kind: names.kind.clone(),
                        singular: names.singular.clone().unwrap_or_default(),
                        plural: names.plural.clone(),
                        short_names: names.short_names.clone().unwrap_or_default(),
                        versions: spec
                            .versions
                            .iter()
                            .map(|v| CrdVersionItem {
                                name: v.name.clone(),
                                served: v.served,
                                storage: v.storage,
                            })
                            .collect(),
                        created_at: meta
                            .creation_timestamp
                            .as_ref()
                            .map(|t| t.0.to_rfc3339()),
                        printer_columns,
                    }
                })
                .collect();

            let total = items.len();
            (StatusCode::OK, Json(ApiResponse { data: items, total })).into_response()
        }
        Err(err) => {
            error!("Error listing CRDs: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn list_custom_resources(
    State(state): State<AppState>,
    Path(crd_name): Path<String>,
    Query(query): Query<NamespaceQuery>,
) -> impl IntoResponse {
    let client = state.kube_client().await;

    // Fetch the CRD definition to learn group/version/kind/plural/scope
    let crd_api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd = match crd_api.get(&crd_name).await {
        Ok(c) => c,
        Err(err) => {
            error!("Error fetching CRD {}: {:?}", crd_name, err);
            return StatusCode::NOT_FOUND.into_response();
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

    let items: Vec<CustomResourceItem> = if spec.scope == "Namespaced" {
        if let Some(ns) = query.namespace {
            let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &ar);
            match api.list(&ListParams::default()).await {
                Ok(list) => list
                    .items
                    .into_iter()
                    .map(|obj| custom_resource_from_dynamic(obj))
                    .collect(),
                Err(err) => {
                    error!("Error listing custom resources for {}: {:?}", crd_name, err);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        } else {
            // All namespaces
            let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
            match api.list(&ListParams::default()).await {
                Ok(list) => list
                    .items
                    .into_iter()
                    .map(|obj| custom_resource_from_dynamic(obj))
                    .collect(),
                Err(err) => {
                    error!("Error listing custom resources for {}: {:?}", crd_name, err);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
    } else {
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        match api.list(&ListParams::default()).await {
            Ok(list) => list
                .items
                .into_iter()
                .map(|obj| custom_resource_from_dynamic(obj))
                .collect(),
            Err(err) => {
                error!("Error listing cluster-scoped custom resources for {}: {:?}", crd_name, err);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };

    let total = items.len();
    (StatusCode::OK, Json(ApiResponse { data: items, total })).into_response()
}

pub async fn get_custom_resource_yaml(
    State(state): State<AppState>,
    Path((crd_name, name)): Path<(String, String)>,
    Query(query): Query<NamespaceQuery>,
) -> impl IntoResponse {
    let client = state.kube_client().await;

    let crd_api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd = match crd_api.get(&crd_name).await {
        Ok(c) => c,
        Err(err) => {
            error!("Error fetching CRD {}: {:?}", crd_name, err);
            return StatusCode::NOT_FOUND.into_response();
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

    let obj = if spec.scope == "Namespaced" {
        let ns = match query.namespace {
            Some(ns) => ns,
            None => {
                return (StatusCode::BAD_REQUEST, "namespace query param required").into_response();
            }
        };
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &ar);
        match api.get(&name).await {
            Ok(o) => o,
            Err(err) => {
                error!("Error fetching custom resource {} in {}: {:?}", name, crd_name, err);
                return StatusCode::NOT_FOUND.into_response();
            }
        }
    } else {
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        match api.get(&name).await {
            Ok(o) => o,
            Err(err) => {
                error!("Error fetching custom resource {} in {}: {:?}", name, crd_name, err);
                return StatusCode::NOT_FOUND.into_response();
            }
        }
    };

    match serde_yaml::to_string(&obj) {
        Ok(yaml) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/x-yaml")],
            yaml,
        )
            .into_response(),
        Err(err) => {
            error!("Error serializing custom resource to YAML: {:?}", err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_custom_resource(
    State(state): State<AppState>,
    Path((crd_name, name)): Path<(String, String)>,
    Query(query): Query<NamespaceQuery>,
) -> impl IntoResponse {
    let client = state.kube_client().await;

    let crd_api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd = match crd_api.get(&crd_name).await {
        Ok(c) => c,
        Err(err) => {
            error!("Error fetching CRD {}: {:?}", crd_name, err);
            return StatusCode::NOT_FOUND.into_response();
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

    let result = if spec.scope == "Namespaced" {
        let ns = match query.namespace {
            Some(ns) => ns,
            None => {
                return (StatusCode::BAD_REQUEST, "namespace query param required").into_response();
            }
        };
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &ar);
        api.delete(&name, &DeleteParams::default()).await
    } else {
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        api.delete(&name, &DeleteParams::default()).await
    };

    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => {
            error!("Error deleting custom resource {} ({}): {:?}", name, crd_name, err);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
