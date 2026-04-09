use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use kube::{runtime::watcher::{watcher, Event}, Api, ResourceExt};
use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use tracing::{error, info, warn};

use crate::proto::kubernetes::{
    kubernetes_watch_server::{KubernetesWatch, KubernetesWatchServer},
    watch_request, watch_response, AckResponse, ErrorResponse, HealthRequest, HealthResponse,
    ListRequest, ListResponse, PongResponse, ResourceType, ResourceUpdate, WatchAction,
    WatchManyRequest, WatchRequest, WatchResponse,
};

type WatcherHandle = tokio::task::JoinHandle<()>;

pub struct KubernetesWatchService {
    kube_client: kube::Client,
    active_connections: Arc<RwLock<HashMap<String, Vec<WatcherHandle>>>>,
}

impl KubernetesWatchService {
    pub fn new(kube_client: kube::Client) -> Self {
        Self {
            kube_client,
            active_connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn into_server(self) -> KubernetesWatchServer<Self> {
        KubernetesWatchServer::new(self)
    }
}

#[tonic::async_trait]
impl KubernetesWatch for KubernetesWatchService {
    type WatchResourcesStream =
        Pin<Box<dyn Stream<Item = Result<WatchResponse, Status>> + Send + 'static>>;

    type WatchManyStream =
        Pin<Box<dyn Stream<Item = Result<WatchResponse, Status>> + Send + 'static>>;

    async fn watch_many(
        &self,
        request: Request<WatchManyRequest>,
    ) -> Result<Response<Self::WatchManyStream>, Status> {
        let req = request.into_inner();
        let (tx, rx) = mpsc::channel::<Result<WatchResponse, Status>>(256);
        let kube_client = self.kube_client.clone();
        let connection_id = uuid::Uuid::new_v4().to_string();

        info!(
            "New gRPC WatchMany connection {}: {} subscriptions",
            connection_id,
            req.subscriptions.len()
        );

        tokio::spawn(async move {
            let mut handles: Vec<WatcherHandle> = Vec::new();

            for sub in req.subscriptions {
                let resource_type = sub.resource_type;
                info!(
                    "WatchMany subscribe: {:?}, namespace: {:?}",
                    ResourceType::try_from(resource_type),
                    sub.namespace
                );
                let tx_clone = tx.clone();
                let client_clone = kube_client.clone();
                let handle = tokio::spawn(async move {
                    if let Err(e) = watch_resource(client_clone, resource_type, sub.namespace, sub.crd_name, tx_clone.clone()).await {
                        let _ = tx_clone
                            .send(Ok(WatchResponse {
                                message: Some(watch_response::Message::Error(ErrorResponse {
                                    message: format!("Watch failed: {}", e),
                                    code: 500,
                                    details: e.to_string(),
                                })),
                            }))
                            .await;
                    }
                });
                handles.push(handle);
            }

            // Wait until the channel closes (client disconnected), then clean up.
            tx.closed().await;
            info!("WatchMany connection {} closed, aborting {} watchers", connection_id, handles.len());
            for h in handles {
                h.abort();
            }
        });

        let out_stream = ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(out_stream)))
    }

    async fn watch_resources(
        &self,
        request: Request<Streaming<WatchRequest>>,
    ) -> Result<Response<Self::WatchResourcesStream>, Status> {
        let mut in_stream = request.into_inner();
        let (tx, rx) = mpsc::channel(256);
        let kube_client = self.kube_client.clone();
        let connection_id = uuid::Uuid::new_v4().to_string();
        let active_connections = self.active_connections.clone();

        info!("New gRPC connection: {}", connection_id);

        // Store connection
        active_connections
            .write()
            .await
            .insert(connection_id.clone(), Vec::new());

        tokio::spawn(async move {
            let mut watchers: HashMap<i32, WatcherHandle> = HashMap::new();

            while let Some(result) = in_stream.next().await {
                match result {
                    Ok(watch_req) => {
                        if let Some(action) = watch_req.action {
                            match action {
                                watch_request::Action::Subscribe(sub) => {
                                    let resource_type = sub.resource_type;
                                    info!(
                                        "Subscribe request: {:?}, namespace: {:?}",
                                        ResourceType::try_from(resource_type),
                                        sub.namespace
                                    );

                                    // Cancel existing watcher for this resource type
                                    if let Some(handle) = watchers.remove(&resource_type) {
                                        handle.abort();
                                    }

                                    let tx_clone = tx.clone();
                                    let client_clone = kube_client.clone();

                                    // Spawn new watcher
                                    let handle = tokio::spawn(async move {
                                        let result = watch_resource(
                                            client_clone,
                                            resource_type,
                                            sub.namespace,
                                            sub.crd_name,
                                            tx_clone.clone(),
                                        )
                                        .await;
                                        
                                        if let Err(e) = result {
                                            let error_response = {
                                                // Extract strings from error in this block
                                                let error_msg = format!("Watch failed: {}", e);
                                                let error_details = e.to_string();
                                                // e goes out of scope here
                                                WatchResponse {
                                                    message: Some(watch_response::Message::Error(
                                                        ErrorResponse {
                                                            message: error_msg,
                                                            code: 500,
                                                            details: error_details,
                                                        },
                                                    )),
                                                }
                                            };
                                            error!("Watch error sent to client");
                                            let _ = tx_clone.send(Ok(error_response)).await;
                                        }
                                    });

                                    watchers.insert(resource_type, handle);

                                    // Send acknowledgment
                                    let _ = tx
                                        .send(Ok(WatchResponse {
                                            message: Some(watch_response::Message::Ack(AckResponse {
                                                resource_type,
                                                subscribed: true,
                                                message: "Subscribed successfully".to_string(),
                                            })),
                                        }))
                                        .await;
                                }
                                watch_request::Action::Unsubscribe(unsub) => {
                                    info!("Unsubscribe request: {:?}", unsub.resource_type);

                                    if let Some(handle) = watchers.remove(&unsub.resource_type) {
                                        handle.abort();
                                    }

                                    let _ = tx
                                        .send(Ok(WatchResponse {
                                            message: Some(watch_response::Message::Ack(AckResponse {
                                                resource_type: unsub.resource_type,
                                                subscribed: false,
                                                message: "Unsubscribed successfully".to_string(),
                                            })),
                                        }))
                                        .await;
                                }
                                watch_request::Action::Ping(ping) => {
                                    let _ = tx
                                        .send(Ok(WatchResponse {
                                            message: Some(watch_response::Message::Pong(
                                                PongResponse {
                                                    timestamp: ping.timestamp,
                                                },
                                            )),
                                        }))
                                        .await;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Stream error: {}", e);
                        break;
                    }
                }
            }

            // Cleanup
            info!("Connection closing: {}", connection_id);
            for (_, handle) in watchers {
                handle.abort();
            }
            active_connections.write().await.remove(&connection_id);
        });

        let out_stream = ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(out_stream)))
    }

    async fn list_resources(
        &self,
        request: Request<ListRequest>,
    ) -> Result<Response<ListResponse>, Status> {
        let req = request.into_inner();
        let resource_type = ResourceType::try_from(req.resource_type)
            .map_err(|_| Status::invalid_argument("Invalid resource type"))?;

        info!("List request: {:?}", resource_type);

        match resource_type {
            ResourceType::Pods => list_pods(&self.kube_client, req.namespace).await,
            ResourceType::Deployments => list_deployments(&self.kube_client, req.namespace).await,
            ResourceType::Services => list_services(&self.kube_client, req.namespace).await,
            ResourceType::Nodes => list_nodes(&self.kube_client).await,
            ResourceType::Events => list_events(&self.kube_client, req.namespace).await,
            ResourceType::Statefulsets => list_statefulsets(&self.kube_client, req.namespace).await,
            ResourceType::Daemonsets => list_daemonsets(&self.kube_client, req.namespace).await,
            ResourceType::Jobs => list_jobs(&self.kube_client, req.namespace).await,
            ResourceType::Cronjobs => list_cronjobs(&self.kube_client, req.namespace).await,
            ResourceType::Replicasets => list_replicasets(&self.kube_client, req.namespace).await,
            ResourceType::Namespaces => list_namespaces(&self.kube_client).await,
            ResourceType::Configmaps => list_configmaps(&self.kube_client, req.namespace).await,
            ResourceType::Secrets => list_secrets(&self.kube_client, req.namespace).await,
            ResourceType::ResourceQuotas => list_resource_quotas(&self.kube_client, req.namespace).await,
            ResourceType::LimitRanges => list_limit_ranges(&self.kube_client, req.namespace).await,
            ResourceType::Hpa => list_hpa(&self.kube_client, req.namespace).await,
            ResourceType::Pdb => list_pdb(&self.kube_client, req.namespace).await,
            ResourceType::Ingresses => list_ingresses(&self.kube_client, req.namespace).await,
            ResourceType::IngressClasses => list_ingress_classes(&self.kube_client).await,
            ResourceType::Endpoints => list_endpoints(&self.kube_client, req.namespace).await,
            ResourceType::NetworkPolicies => list_network_policies(&self.kube_client, req.namespace).await,
            ResourceType::PersistentVolumes => list_persistent_volumes(&self.kube_client).await,
            ResourceType::PersistentVolumeClaims => list_persistent_volume_claims(&self.kube_client, req.namespace).await,
            ResourceType::StorageClasses => list_storage_classes(&self.kube_client).await,
            ResourceType::ServiceAccounts => list_service_accounts(&self.kube_client, req.namespace).await,
            ResourceType::ClusterRoles => list_cluster_roles(&self.kube_client).await,
            ResourceType::ClusterRoleBindings => list_cluster_role_bindings(&self.kube_client).await,
            ResourceType::Roles => list_roles(&self.kube_client, req.namespace).await,
            ResourceType::RoleBindings => list_role_bindings(&self.kube_client, req.namespace).await,
            ResourceType::PriorityClasses => list_priority_classes(&self.kube_client).await,
            ResourceType::RuntimeClasses => list_runtime_classes(&self.kube_client).await,
            ResourceType::Leases => list_leases(&self.kube_client, req.namespace).await,
            ResourceType::MutatingWebhookConfigurations => list_mutating_webhooks(&self.kube_client).await,
            ResourceType::ValidatingWebhookConfigurations => list_validating_webhooks(&self.kube_client).await,
            ResourceType::CustomResourceDefinitions => list_crds(&self.kube_client).await,
            ResourceType::CustomResources => {
                Err(Status::unimplemented("Use WatchMany for custom resources"))
            }
            ResourceType::Unspecified => {
                Err(Status::invalid_argument("Resource type is required"))
            }
        }
    }

    async fn health(
        &self,
        _request: Request<HealthRequest>,
    ) -> Result<Response<HealthResponse>, Status> {
        // Check K8s API connectivity
        match self.kube_client.apiserver_version().await {
            Ok(_) => Ok(Response::new(HealthResponse {
                healthy: true,
                status: "OK".to_string(),
            })),
            Err(e) => Ok(Response::new(HealthResponse {
                healthy: false,
                status: format!("K8s API error: {}", e),
            })),
        }
    }
}

async fn watch_resource(
    client: kube::Client,
    resource_type: i32,
    namespace: Option<String>,
    crd_name: Option<String>,
    tx: mpsc::Sender<Result<WatchResponse, Status>>,
) -> anyhow::Result<()> {
    match ResourceType::try_from(resource_type) {
        Ok(ResourceType::Pods) => watch_pods(client, namespace, tx).await,
        Ok(ResourceType::Deployments) => watch_deployments(client, namespace, tx).await,
        Ok(ResourceType::Services) => watch_services(client, namespace, tx).await,
        Ok(ResourceType::Nodes) => watch_nodes(client, tx).await,
        Ok(ResourceType::Events) => watch_events(client, namespace, tx).await,
        Ok(ResourceType::Statefulsets) => watch_statefulsets(client, namespace, tx).await,
        Ok(ResourceType::Daemonsets) => watch_daemonsets(client, namespace, tx).await,
        Ok(ResourceType::Jobs) => watch_jobs(client, namespace, tx).await,
        Ok(ResourceType::Cronjobs) => watch_cronjobs(client, namespace, tx).await,
        Ok(ResourceType::Replicasets) => watch_replicasets(client, namespace, tx).await,
        Ok(ResourceType::Namespaces) => watch_namespaces(client, tx).await,
        Ok(ResourceType::Configmaps) => watch_configmaps(client, namespace, tx).await,
        Ok(ResourceType::Secrets) => watch_secrets(client, namespace, tx).await,
        Ok(ResourceType::ResourceQuotas) => watch_resource_quotas(client, namespace, tx).await,
        Ok(ResourceType::LimitRanges) => watch_limit_ranges(client, namespace, tx).await,
        Ok(ResourceType::Hpa) => watch_hpa(client, namespace, tx).await,
        Ok(ResourceType::Pdb) => watch_pdb(client, namespace, tx).await,
        Ok(ResourceType::Ingresses) => watch_ingresses(client, namespace, tx).await,
        Ok(ResourceType::IngressClasses) => watch_ingress_classes(client, tx).await,
        Ok(ResourceType::Endpoints) => watch_endpoints(client, namespace, tx).await,
        Ok(ResourceType::NetworkPolicies) => watch_network_policies(client, namespace, tx).await,
        Ok(ResourceType::PersistentVolumes) => watch_persistent_volumes(client, tx).await,
        Ok(ResourceType::PersistentVolumeClaims) => watch_persistent_volume_claims(client, namespace, tx).await,
        Ok(ResourceType::StorageClasses) => watch_storage_classes(client, tx).await,
        Ok(ResourceType::ServiceAccounts) => watch_service_accounts(client, namespace, tx).await,
        Ok(ResourceType::ClusterRoles) => watch_cluster_roles(client, tx).await,
        Ok(ResourceType::ClusterRoleBindings) => watch_cluster_role_bindings(client, tx).await,
        Ok(ResourceType::Roles) => watch_roles(client, namespace, tx).await,
        Ok(ResourceType::RoleBindings) => watch_role_bindings(client, namespace, tx).await,
        Ok(ResourceType::PriorityClasses) => watch_priority_classes(client, tx).await,
        Ok(ResourceType::RuntimeClasses) => watch_runtime_classes(client, tx).await,
        Ok(ResourceType::Leases) => watch_leases(client, namespace, tx).await,
        Ok(ResourceType::MutatingWebhookConfigurations) => watch_mutating_webhooks(client, tx).await,
        Ok(ResourceType::ValidatingWebhookConfigurations) => watch_validating_webhooks(client, tx).await,
        Ok(ResourceType::CustomResourceDefinitions) => watch_crds(client, tx).await,
        Ok(ResourceType::CustomResources) => {
            let name = crd_name.ok_or_else(|| anyhow::anyhow!("crd_name required for CUSTOM_RESOURCES"))?;
            watch_custom_resources_dynamic(client, name, namespace, tx).await
        }
        Ok(ResourceType::Unspecified) => {
            Err(anyhow::anyhow!("Resource type is required"))
        }
        _ => {
            warn!("Unsupported resource type: {}", resource_type);
            Ok(())
        }
    }
}

async fn send_resource_update<T: serde::Serialize + ResourceExt>(
    tx: &mpsc::Sender<Result<WatchResponse, Status>>,
    resource_type: ResourceType,
    action: WatchAction,
    resource: &T,
) -> anyhow::Result<()> {
    let data = serde_json::to_vec(resource)?;
    let resource_version = resource.resource_version().unwrap_or_default();

    let response = WatchResponse {
        message: Some(watch_response::Message::ResourceUpdate(ResourceUpdate {
            resource_type: resource_type as i32,
            action: action as i32,
            data,
            resource_version,
            timestamp: chrono::Utc::now().timestamp(),
        })),
    };

    if tx.send(Ok(response)).await.is_err() {
        return Err(anyhow::anyhow!("Client disconnected"));
    }

    Ok(())
}

macro_rules! create_watch_fn {
    ($fn_name:ident, $resource:ty, $resource_type:expr, namespaced) => {
        async fn $fn_name(
            client: kube::Client,
            namespace: Option<String>,
            tx: mpsc::Sender<Result<WatchResponse, Status>>,
        ) -> anyhow::Result<()> {
            let api: Api<$resource> = if let Some(ns) = namespace {
                Api::namespaced(client, &ns)
            } else {
                Api::all(client)
            };

            let stream = watcher(api, Default::default());
            tokio::pin!(stream);

            while let Some(result) = stream.next().await {
                match result {
                    Ok(event) => match event {
                        Event::Applied(resource) => {
                            send_resource_update(&tx, $resource_type, WatchAction::Modified, &resource)
                                .await?;
                        }
                        Event::Deleted(resource) => {
                            send_resource_update(&tx, $resource_type, WatchAction::Deleted, &resource)
                                .await?;
                        }
                        Event::Restarted(resources) => {
                            for resource in resources {
                                send_resource_update(&tx, $resource_type, WatchAction::Added, &resource)
                                    .await?;
                            }
                        }
                    },
                    Err(e) => {
                        error!("Watch error for {:?}: {}", $resource_type, e);
                        break;
                    }
                }
            }

            Ok(())
        }
    };
    ($fn_name:ident, $resource:ty, $resource_type:expr, cluster) => {
        async fn $fn_name(
            client: kube::Client,
            tx: mpsc::Sender<Result<WatchResponse, Status>>,
        ) -> anyhow::Result<()> {
            let api: Api<$resource> = Api::all(client);

            let stream = watcher(api, Default::default());
            tokio::pin!(stream);

            while let Some(result) = stream.next().await {
                match result {
                    Ok(event) => match event {
                        Event::Applied(resource) => {
                            send_resource_update(&tx, $resource_type, WatchAction::Modified, &resource)
                                .await?;
                        }
                        Event::Deleted(resource) => {
                            send_resource_update(&tx, $resource_type, WatchAction::Deleted, &resource)
                                .await?;
                        }
                        Event::Restarted(resources) => {
                            for resource in resources {
                                send_resource_update(&tx, $resource_type, WatchAction::Added, &resource)
                                    .await?;
                            }
                        }
                    },
                    Err(e) => {
                        error!("Watch error for {:?}: {}", $resource_type, e);
                        break;
                    }
                }
            }

            Ok(())
        }
    };
}

create_watch_fn!(watch_pods, k8s_openapi::api::core::v1::Pod, ResourceType::Pods, namespaced);
create_watch_fn!(watch_deployments, k8s_openapi::api::apps::v1::Deployment, ResourceType::Deployments, namespaced);
create_watch_fn!(watch_services, k8s_openapi::api::core::v1::Service, ResourceType::Services, namespaced);
create_watch_fn!(watch_events, k8s_openapi::api::core::v1::Event, ResourceType::Events, namespaced);
create_watch_fn!(watch_statefulsets, k8s_openapi::api::apps::v1::StatefulSet, ResourceType::Statefulsets, namespaced);
create_watch_fn!(watch_daemonsets, k8s_openapi::api::apps::v1::DaemonSet, ResourceType::Daemonsets, namespaced);
create_watch_fn!(watch_jobs, k8s_openapi::api::batch::v1::Job, ResourceType::Jobs, namespaced);
create_watch_fn!(watch_cronjobs, k8s_openapi::api::batch::v1::CronJob, ResourceType::Cronjobs, namespaced);
create_watch_fn!(watch_replicasets, k8s_openapi::api::apps::v1::ReplicaSet, ResourceType::Replicasets, namespaced);
create_watch_fn!(watch_nodes, k8s_openapi::api::core::v1::Node, ResourceType::Nodes, cluster);
create_watch_fn!(watch_namespaces, k8s_openapi::api::core::v1::Namespace, ResourceType::Namespaces, cluster);
create_watch_fn!(watch_configmaps, k8s_openapi::api::core::v1::ConfigMap, ResourceType::Configmaps, namespaced);
create_watch_fn!(watch_secrets, k8s_openapi::api::core::v1::Secret, ResourceType::Secrets, namespaced);
create_watch_fn!(watch_resource_quotas, k8s_openapi::api::core::v1::ResourceQuota, ResourceType::ResourceQuotas, namespaced);
create_watch_fn!(watch_limit_ranges, k8s_openapi::api::core::v1::LimitRange, ResourceType::LimitRanges, namespaced);
create_watch_fn!(watch_hpa, k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler, ResourceType::Hpa, namespaced);
create_watch_fn!(watch_pdb, k8s_openapi::api::policy::v1::PodDisruptionBudget, ResourceType::Pdb, namespaced);
create_watch_fn!(watch_ingresses, k8s_openapi::api::networking::v1::Ingress, ResourceType::Ingresses, namespaced);
create_watch_fn!(watch_ingress_classes, k8s_openapi::api::networking::v1::IngressClass, ResourceType::IngressClasses, cluster);
create_watch_fn!(watch_endpoints, k8s_openapi::api::core::v1::Endpoints, ResourceType::Endpoints, namespaced);
create_watch_fn!(watch_network_policies, k8s_openapi::api::networking::v1::NetworkPolicy, ResourceType::NetworkPolicies, namespaced);
create_watch_fn!(watch_persistent_volumes, k8s_openapi::api::core::v1::PersistentVolume, ResourceType::PersistentVolumes, cluster);
create_watch_fn!(watch_persistent_volume_claims, k8s_openapi::api::core::v1::PersistentVolumeClaim, ResourceType::PersistentVolumeClaims, namespaced);
create_watch_fn!(watch_storage_classes, k8s_openapi::api::storage::v1::StorageClass, ResourceType::StorageClasses, cluster);
create_watch_fn!(watch_service_accounts, k8s_openapi::api::core::v1::ServiceAccount, ResourceType::ServiceAccounts, namespaced);
create_watch_fn!(watch_cluster_roles, k8s_openapi::api::rbac::v1::ClusterRole, ResourceType::ClusterRoles, cluster);
create_watch_fn!(watch_cluster_role_bindings, k8s_openapi::api::rbac::v1::ClusterRoleBinding, ResourceType::ClusterRoleBindings, cluster);
create_watch_fn!(watch_roles, k8s_openapi::api::rbac::v1::Role, ResourceType::Roles, namespaced);
create_watch_fn!(watch_role_bindings, k8s_openapi::api::rbac::v1::RoleBinding, ResourceType::RoleBindings, namespaced);
create_watch_fn!(watch_priority_classes, k8s_openapi::api::scheduling::v1::PriorityClass, ResourceType::PriorityClasses, cluster);
create_watch_fn!(watch_runtime_classes, k8s_openapi::api::node::v1::RuntimeClass, ResourceType::RuntimeClasses, cluster);
create_watch_fn!(watch_leases, k8s_openapi::api::coordination::v1::Lease, ResourceType::Leases, namespaced);
create_watch_fn!(watch_mutating_webhooks, k8s_openapi::api::admissionregistration::v1::MutatingWebhookConfiguration, ResourceType::MutatingWebhookConfigurations, cluster);
create_watch_fn!(watch_validating_webhooks, k8s_openapi::api::admissionregistration::v1::ValidatingWebhookConfiguration, ResourceType::ValidatingWebhookConfigurations, cluster);
create_watch_fn!(watch_crds, k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition, ResourceType::CustomResourceDefinitions, cluster);

macro_rules! create_list_fn {
    ($fn_name:ident, $resource:ty, namespaced) => {
        async fn $fn_name(
            client: &kube::Client,
            namespace: Option<String>,
        ) -> Result<Response<ListResponse>, Status> {
            let api: Api<$resource> = if let Some(ns) = namespace {
                Api::namespaced(client.clone(), &ns)
            } else {
                Api::all(client.clone())
            };

            let list = api
                .list(&Default::default())
                .await
                .map_err(|e| Status::internal(format!("Failed to list resources: {}", e)))?;

            let items: Vec<Vec<u8>> = list
                .items
                .iter()
                .filter_map(|item| serde_json::to_vec(item).ok())
                .collect();

            let count = items.len() as i32;

            Ok(Response::new(ListResponse {
                items,
                resource_version: list.metadata.resource_version.unwrap_or_default(),
                count,
            }))
        }
    };
    ($fn_name:ident, $resource:ty, cluster) => {
        async fn $fn_name(client: &kube::Client) -> Result<Response<ListResponse>, Status> {
            let api: Api<$resource> = Api::all(client.clone());

            let list = api
                .list(&Default::default())
                .await
                .map_err(|e| Status::internal(format!("Failed to list resources: {}", e)))?;

            let items: Vec<Vec<u8>> = list
                .items
                .iter()
                .filter_map(|item| serde_json::to_vec(item).ok())
                .collect();

            let count = items.len() as i32;

            Ok(Response::new(ListResponse {
                items,
                resource_version: list.metadata.resource_version.unwrap_or_default(),
                count,
            }))
        }
    };
}

create_list_fn!(list_pods, k8s_openapi::api::core::v1::Pod, namespaced);
create_list_fn!(list_deployments, k8s_openapi::api::apps::v1::Deployment, namespaced);
create_list_fn!(list_services, k8s_openapi::api::core::v1::Service, namespaced);
create_list_fn!(list_events, k8s_openapi::api::core::v1::Event, namespaced);
create_list_fn!(list_statefulsets, k8s_openapi::api::apps::v1::StatefulSet, namespaced);
create_list_fn!(list_daemonsets, k8s_openapi::api::apps::v1::DaemonSet, namespaced);
create_list_fn!(list_jobs, k8s_openapi::api::batch::v1::Job, namespaced);
create_list_fn!(list_cronjobs, k8s_openapi::api::batch::v1::CronJob, namespaced);
create_list_fn!(list_replicasets, k8s_openapi::api::apps::v1::ReplicaSet, namespaced);
create_list_fn!(list_nodes, k8s_openapi::api::core::v1::Node, cluster);
create_list_fn!(list_namespaces, k8s_openapi::api::core::v1::Namespace, cluster);
create_list_fn!(list_configmaps, k8s_openapi::api::core::v1::ConfigMap, namespaced);
create_list_fn!(list_secrets, k8s_openapi::api::core::v1::Secret, namespaced);
create_list_fn!(list_resource_quotas, k8s_openapi::api::core::v1::ResourceQuota, namespaced);
create_list_fn!(list_limit_ranges, k8s_openapi::api::core::v1::LimitRange, namespaced);
create_list_fn!(list_hpa, k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler, namespaced);
create_list_fn!(list_pdb, k8s_openapi::api::policy::v1::PodDisruptionBudget, namespaced);
create_list_fn!(list_ingresses, k8s_openapi::api::networking::v1::Ingress, namespaced);
create_list_fn!(list_ingress_classes, k8s_openapi::api::networking::v1::IngressClass, cluster);
create_list_fn!(list_endpoints, k8s_openapi::api::core::v1::Endpoints, namespaced);
create_list_fn!(list_network_policies, k8s_openapi::api::networking::v1::NetworkPolicy, namespaced);
create_list_fn!(list_persistent_volumes, k8s_openapi::api::core::v1::PersistentVolume, cluster);
create_list_fn!(list_persistent_volume_claims, k8s_openapi::api::core::v1::PersistentVolumeClaim, namespaced);
create_list_fn!(list_storage_classes, k8s_openapi::api::storage::v1::StorageClass, cluster);
create_list_fn!(list_service_accounts, k8s_openapi::api::core::v1::ServiceAccount, namespaced);
create_list_fn!(list_cluster_roles, k8s_openapi::api::rbac::v1::ClusterRole, cluster);
create_list_fn!(list_cluster_role_bindings, k8s_openapi::api::rbac::v1::ClusterRoleBinding, cluster);
create_list_fn!(list_roles, k8s_openapi::api::rbac::v1::Role, namespaced);
create_list_fn!(list_role_bindings, k8s_openapi::api::rbac::v1::RoleBinding, namespaced);
create_list_fn!(list_priority_classes, k8s_openapi::api::scheduling::v1::PriorityClass, cluster);
create_list_fn!(list_runtime_classes, k8s_openapi::api::node::v1::RuntimeClass, cluster);
create_list_fn!(list_leases, k8s_openapi::api::coordination::v1::Lease, namespaced);
create_list_fn!(list_mutating_webhooks, k8s_openapi::api::admissionregistration::v1::MutatingWebhookConfiguration, cluster);
create_list_fn!(list_validating_webhooks, k8s_openapi::api::admissionregistration::v1::ValidatingWebhookConfiguration, cluster);
create_list_fn!(list_crds, k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition, cluster);

/// Watch a custom resource type identified by CRD name (e.g. "crontabs.stable.example.com").
async fn watch_custom_resources_dynamic(
    client: kube::Client,
    crd_name: String,
    namespace: Option<String>,
    tx: mpsc::Sender<Result<WatchResponse, Status>>,
) -> anyhow::Result<()> {
    let crd_api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd = crd_api.get(&crd_name).await
        .map_err(|e| anyhow::anyhow!("CRD '{}' not found: {}", crd_name, e))?;

    let spec = crd.spec;
    let group = spec.group;
    let names = spec.names;
    let storage_version = spec.versions.iter()
        .find(|v| v.storage)
        .map(|v| v.name.clone())
        .unwrap_or_else(|| spec.versions.first().map(|v| v.name.clone()).unwrap_or_default());

    let gvk = GroupVersionKind::gvk(&group, &storage_version, &names.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &names.plural);

    let api: Api<DynamicObject> = match &namespace {
        Some(ns) => Api::namespaced_with(client, ns, &ar),
        None => Api::all_with(client, &ar),
    };

    let stream = watcher(api, Default::default());
    tokio::pin!(stream);

    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => match event {
                Event::Applied(resource) => {
                    let data = serde_json::to_vec(&resource)?;
                    let rv = resource.metadata.resource_version.unwrap_or_default();
                    let response = WatchResponse {
                        message: Some(watch_response::Message::ResourceUpdate(ResourceUpdate {
                            resource_type: ResourceType::CustomResources as i32,
                            action: WatchAction::Modified as i32,
                            data,
                            resource_version: rv,
                            timestamp: chrono::Utc::now().timestamp(),
                        })),
                    };
                    if tx.send(Ok(response)).await.is_err() {
                        return Ok(());
                    }
                }
                Event::Deleted(resource) => {
                    let data = serde_json::to_vec(&resource)?;
                    let rv = resource.metadata.resource_version.unwrap_or_default();
                    let response = WatchResponse {
                        message: Some(watch_response::Message::ResourceUpdate(ResourceUpdate {
                            resource_type: ResourceType::CustomResources as i32,
                            action: WatchAction::Deleted as i32,
                            data,
                            resource_version: rv,
                            timestamp: chrono::Utc::now().timestamp(),
                        })),
                    };
                    if tx.send(Ok(response)).await.is_err() {
                        return Ok(());
                    }
                }
                Event::Restarted(resources) => {
                    for resource in resources {
                        let data = serde_json::to_vec(&resource)?;
                        let rv = resource.metadata.resource_version.unwrap_or_default();
                        let response = WatchResponse {
                            message: Some(watch_response::Message::ResourceUpdate(ResourceUpdate {
                                resource_type: ResourceType::CustomResources as i32,
                                action: WatchAction::Added as i32,
                                data,
                                resource_version: rv,
                                timestamp: chrono::Utc::now().timestamp(),
                            })),
                        };
                        if tx.send(Ok(response)).await.is_err() {
                            return Ok(());
                        }
                    }
                }
            },
            Err(e) => {
                error!("Custom resource watch error for {}: {}", crd_name, e);
                break;
            }
        }
    }

    Ok(())
}
