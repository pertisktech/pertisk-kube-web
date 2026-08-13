use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use kube::{runtime::watcher::{watcher, Event}, Api, ResourceExt};
use tracing::{error, info, warn};

use crate::proto::kubernetes::{
    kubernetes_watch_server::{KubernetesWatch, KubernetesWatchServer},
    watch_request, watch_response, AckResponse, ErrorResponse, HealthRequest, HealthResponse,
    ListRequest, ListResponse, PongResponse, ResourceType, ResourceUpdate, WatchAction,
    WatchRequest, WatchResponse,
};

type WatcherHandle = tokio::task::JoinHandle<()>;

pub struct KubernetesWatchService {
    kube_client: Arc<RwLock<kube::Client>>,
    active_connections: Arc<RwLock<HashMap<String, Vec<WatcherHandle>>>>,
}

impl KubernetesWatchService {
    pub fn new(kube_client: Arc<RwLock<kube::Client>>) -> Self {
        Self {
            kube_client,
            active_connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn into_server(self) -> KubernetesWatchServer<Self> {
        KubernetesWatchServer::new(self)
    }

    async fn current_client(&self) -> kube::Client {
        self.kube_client.read().await.clone()
    }
}

#[tonic::async_trait]
impl KubernetesWatch for KubernetesWatchService {
    type WatchResourcesStream =
        Pin<Box<dyn Stream<Item = Result<WatchResponse, Status>> + Send + 'static>>;

    async fn watch_resources(
        &self,
        request: Request<Streaming<WatchRequest>>,
    ) -> Result<Response<Self::WatchResourcesStream>, Status> {
        let mut in_stream = request.into_inner();
        let (tx, rx) = mpsc::channel(256);
        let kube_client = self.current_client().await;
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

        let client = self.current_client().await;
        match resource_type {
            ResourceType::Pods => list_pods(&client, req.namespace).await,
            ResourceType::Deployments => list_deployments(&client, req.namespace).await,
            ResourceType::Services => list_services(&client, req.namespace).await,
            ResourceType::Nodes => list_nodes(&client).await,
            ResourceType::Events => list_events(&client, req.namespace).await,
            ResourceType::Statefulsets => list_statefulsets(&client, req.namespace).await,
            ResourceType::Daemonsets => list_daemonsets(&client, req.namespace).await,
            ResourceType::Jobs => list_jobs(&client, req.namespace).await,
            ResourceType::Cronjobs => list_cronjobs(&client, req.namespace).await,
            ResourceType::Replicasets => list_replicasets(&client, req.namespace).await,
            ResourceType::Namespaces => list_namespaces(&client).await,
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
        match self.current_client().await.apiserver_version().await {
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
