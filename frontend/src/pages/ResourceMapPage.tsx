import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  getNodesBounds,
  getViewportForBounds,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
  Panel,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toPng } from 'html-to-image';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  Boxes,
  Briefcase,
  Clock,
  Cpu,
  Database,
  ChevronDown,
  ChevronUp,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Maximize2,
  Minus,
  Minimize2,
  Monitor,
  Network,
  Plus,
  Loader,
  RefreshCw,
  Upload,
  X,
} from '../components/Icons';
import type { IconComponent } from '../components/Icons';
import { useNamespace } from '../context/NamespaceContext';
import { useResourceMap } from '../hooks/useKubernetes';
import type { ResourceMapNode as ApiNode, ResourceMapEdge as ApiEdge } from '../types';
import { cn } from '../utils';
import { toast } from 'sonner';

// ── Resource kind configuration ───────────────────────────────────────────────
interface KindConfig {
  color: string;
  bg: string;
  border: string;
  icon: IconComponent;
  navPath?: string;
}

interface ResourceFlowNodeData extends Record<string, unknown>, ApiNode {
  collapsed: boolean;
  canToggleCollapse: boolean;
  onToggleCollapse: (nodeId: string) => void;
}

const KIND_CONFIG: Record<string, KindConfig> = {
  // ── Workloads ──
  Pod:            { color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/30',    icon: Cpu,       navPath: '/pods' },
  Deployment:     { color: 'text-purple-400',  bg: 'bg-purple-500/10',  border: 'border-purple-500/30',  icon: Archive,   navPath: '/deployments' },
  ReplicaSet:     { color: 'text-indigo-400',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/30',  icon: Boxes,     navPath: '/replicasets' },
  StatefulSet:    { color: 'text-teal-400',    bg: 'bg-teal-500/10',    border: 'border-teal-500/30',    icon: Database,  navPath: '/statefulsets' },
  DaemonSet:      { color: 'text-pink-400',    bg: 'bg-pink-500/10',    border: 'border-pink-500/30',    icon: Monitor,   navPath: '/daemonsets' },
  CronJob:        { color: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30',  icon: Clock,     navPath: '/cronjobs' },
  Job:            { color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   icon: Briefcase, navPath: '/jobs' },
  // ── Network ──
  Ingress:        { color: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30',  icon: Globe,     navPath: '/network/ingresses' },
  Service:        { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: Network,   navPath: '/network/services' },
  HPA:            { color: 'text-lime-400',    bg: 'bg-lime-500/10',    border: 'border-lime-500/30',    icon: Gauge,     navPath: '/config/hpa' },
  // ── Config ──
  ConfigMap:      { color: 'text-sky-400',     bg: 'bg-sky-500/10',     border: 'border-sky-500/30',     icon: FileText,  navPath: '/config/configmaps' },
  Secret:         { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     icon: KeyRound,  navPath: '/config/secrets' },
  ServiceAccount: { color: 'text-cyan-400',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/30',    icon: KeyRound,  navPath: '/access-control/serviceaccounts' },
  // ── Storage ──
  PVC:            { color: 'text-violet-400',  bg: 'bg-violet-500/10',  border: 'border-violet-500/30',  icon: HardDrive, navPath: '/storage/pvc' },
  PV:             { color: 'text-slate-400',   bg: 'bg-slate-500/10',   border: 'border-slate-500/30',   icon: HardDrive, navPath: '/storage/pv' },
};

const STATUS_DOT: Record<string, string> = {
  Running: 'bg-emerald-400',
  ready: 'bg-emerald-400',
  active: 'bg-emerald-400',
  completed: 'bg-sky-400',
  Succeeded: 'bg-sky-400',
  running: 'bg-emerald-400',
  degraded: 'bg-red-400',
  failed: 'bg-red-400',
  Failed: 'bg-red-400',
  Pending: 'bg-amber-400',
  pending: 'bg-amber-400',
};

// MiniMap node colors
const MINIMAP_COLOR: Record<string, string> = {
  // workloads
  Pod:            '#3b82f6',
  Deployment:     '#a855f7',
  ReplicaSet:     '#6366f1',
  StatefulSet:    '#14b8a6',
  DaemonSet:      '#ec4899',
  CronJob:        '#eab308',
  Job:            '#f59e0b',
  // network
  Ingress:        '#f97316',
  Service:        '#22c55e',
  HPA:            '#84cc16',
  // config
  ConfigMap:      '#0ea5e9',
  Secret:         '#ef4444',
  ServiceAccount: '#06b6d4',
  // storage
  PVC:            '#8b5cf6',
  PV:             '#64748b',
};

// ── Column layout ─────────────────────────────────────────────────────────────
// Every "owns" edge is at most 1 column hop → no edges pass through other nodes.
// Ingress(0) → Service+HPA(1) → Deployment+SS+DS+CronJob(2) → RS+Job(3)
//   → Pod(4) → ConfigMap+Secret+SA(5) → PVC(6) → PV(7)
const KIND_COL: Record<string, number> = {
  Ingress:        0,
  HPA:            1,
  Service:        1,
  Deployment:     2,
  StatefulSet:    2,
  DaemonSet:      2,
  CronJob:        2,
  ReplicaSet:     3,
  Job:            3,
  Pod:            4,
  ConfigMap:      5,
  Secret:         5,
  ServiceAccount: 5,
  PVC:            6,
  PV:             7,
};

const NODE_WIDTH = 192;
const COL_GAP = 272;
const ROW_GAP = 86;

function computeVisibleNodeIds(apiNodes: ApiNode[], apiEdges: ApiEdge[], collapsedNodeIds: Set<string>) {
  const nodeIds = new Set(apiNodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();

  apiNodes.forEach((node) => {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
  });

  apiEdges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    outgoing.get(edge.source)?.push(edge.target);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  });

  const visitFrom = (startId: string, visibleNodeIds: Set<string>) => {
    const stack = [startId];
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (visibleNodeIds.has(currentId)) continue;
      visibleNodeIds.add(currentId);

      if (collapsedNodeIds.has(currentId)) {
        continue;
      }

      const children = outgoing.get(currentId) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
  };

  const visibleNodeIds = new Set<string>();
  const rootIds = apiNodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .map((node) => node.id);

  (rootIds.length > 0 ? rootIds : apiNodes.map((node) => node.id)).forEach((nodeId) => {
    visitFrom(nodeId, visibleNodeIds);
  });

  if (visibleNodeIds.size < apiNodes.length) {
    apiNodes.forEach((node) => {
      if (!visibleNodeIds.has(node.id)) {
        visitFrom(node.id, visibleNodeIds);
      }
    });
  }

  return { visibleNodeIds, outgoing };
}

function computeLayout(apiNodes: ApiNode[], apiEdges: ApiEdge[], getNodeData: (node: ApiNode) => ResourceFlowNodeData) {
  const colNodes: Record<number, ApiNode[]> = {};
  for (const n of apiNodes) {
    const col = KIND_COL[n.kind] ?? 5;
    if (!colNodes[col]) colNodes[col] = [];
    colNodes[col].push(n);
  }

  const compareNodes = (a: ApiNode, b: ApiNode) => {
    const nsA = a.namespace ?? '';
    const nsB = b.namespace ?? '';
    return nsA !== nsB ? nsA.localeCompare(nsB) : a.name.localeCompare(b.name);
  };

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  apiNodes.forEach((node) => {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  });

  apiEdges.forEach((edge) => {
    incoming.get(edge.target)?.push(edge.source);
    outgoing.get(edge.source)?.push(edge.target);
  });

  const sortedCols = Object.keys(colNodes)
    .map(Number)
    .sort((a, b) => a - b);

  sortedCols.forEach((col) => {
    colNodes[col].sort(compareNodes);
  });

  const orderIndex = new Map<string, number>();
  const refreshOrderIndex = () => {
    sortedCols.forEach((col) => {
      colNodes[col].forEach((node, index) => {
        orderIndex.set(node.id, index);
      });
    });
  };

  const getBarycenter = (neighborIds: string[]) => {
    const positions = neighborIds
      .map((id) => orderIndex.get(id))
      .filter((value): value is number => value !== undefined);
    if (positions.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    return positions.reduce((sum, value) => sum + value, 0) / positions.length;
  };

  refreshOrderIndex();

  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = 1; i < sortedCols.length; i += 1) {
      const col = sortedCols[i];
      colNodes[col].sort((a, b) => {
        const baryA = getBarycenter(incoming.get(a.id) ?? []);
        const baryB = getBarycenter(incoming.get(b.id) ?? []);
        if (baryA === baryB) return compareNodes(a, b);
        return baryA - baryB;
      });
      refreshOrderIndex();
    }

    for (let i = sortedCols.length - 2; i >= 0; i -= 1) {
      const col = sortedCols[i];
      colNodes[col].sort((a, b) => {
        const baryA = getBarycenter(outgoing.get(a.id) ?? []);
        const baryB = getBarycenter(outgoing.get(b.id) ?? []);
        if (baryA === baryB) return compareNodes(a, b);
        return baryA - baryB;
      });
      refreshOrderIndex();
    }
  }

  const posMap: Record<string, { x: number; y: number }> = {};
  for (const [colStr, nodes] of Object.entries(colNodes)) {
    const col = Number(colStr);
    nodes.forEach((n, i) => {
      posMap[n.id] = { x: col * COL_GAP, y: i * ROW_GAP };
    });
  }

  const rfNodes: Node<ResourceFlowNodeData>[] = apiNodes.map((n) => ({
    id: n.id,
    type: 'resourceNode',
    position: posMap[n.id] ?? { x: 0, y: 0 },
    data: getNodeData(n),
  }));

  const EDGE_STYLE: Record<string, { stroke: string; dash?: string; animated?: boolean }> = {
    owns:     { stroke: 'var(--color-border)' },
    selects:  { stroke: '#22c55e', animated: true },
    routes:   { stroke: '#f97316', dash: '5 3' },
    scales:   { stroke: '#84cc16', dash: '6 2' },
    uses:     { stroke: '#0ea5e9', dash: '4 3' },
    uses_sa:  { stroke: '#06b6d4', dash: '4 3' },
    mounts:   { stroke: '#8b5cf6' },
    binds:    { stroke: '#64748b', dash: '3 3' },
  };

  const rfEdges: Edge[] = apiEdges.map((e) => {
    const style = EDGE_STYLE[e.edge_type] ?? EDGE_STYLE['owns'];
    // Use bezier for edges that skip columns (e.g. SS/DS → Pod) so they arc
    // above the graph instead of stepping through intermediate nodes.
    const ID_PREFIX_KIND: Record<string, string> = {
      pod: 'Pod', deployment: 'Deployment', replicaset: 'ReplicaSet',
      statefulset: 'StatefulSet', daemonset: 'DaemonSet', cronjob: 'CronJob',
      job: 'Job', service: 'Service', ingress: 'Ingress', hpa: 'HPA',
      configmap: 'ConfigMap', secret: 'Secret', serviceaccount: 'ServiceAccount',
      pvc: 'PVC', pv: 'PV',
    };
    const colOf = (id: string) => KIND_COL[ID_PREFIX_KIND[id.split('/')[0]] ?? ''] ?? 0;
    const sourceCol = colOf(e.source);
    const targetCol = colOf(e.target);
    const edgeType = Math.abs(targetCol - sourceCol) > 1 ? 'default' : 'smoothstep';
    return {
      id: `${e.source}--${e.target}`,
      source: e.source,
      target: e.target,
      type: edgeType,
      animated: style.animated ?? false,
      style: {
        stroke: style.stroke,
        strokeDasharray: style.dash,
        strokeWidth: 1.5,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: style.stroke,
        width: 14,
        height: 14,
      },
    };
  });

  return { rfNodes, rfEdges };
}

// ── Custom node component ─────────────────────────────────────────────────────
const ResourceNode = memo(({ data, selected }: NodeProps<Node<ResourceFlowNodeData>>) => {
  const node = data as ResourceFlowNodeData;
  const config = KIND_CONFIG[node.kind] ?? KIND_CONFIG['Pod'];
  const Icon = config.icon;
  const dotColor = STATUS_DOT[node.status] ?? 'bg-neutral-400';

  return (
    <div
      className={cn(
        'rounded-lg border bg-[var(--color-surface)] shadow-sm px-3 py-2.5 flex items-center gap-2.5 transition-shadow',
        config.border,
        selected && 'ring-2 ring-[var(--color-primary)] ring-offset-0 shadow-md',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: 'transparent', border: 'none', width: 6, height: 6 }}
      />
      <div className={cn('p-1.5 rounded-md shrink-0', config.bg)}>
        <Icon size={13} className={config.color} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className={cn('text-[9px] font-bold uppercase tracking-wide leading-none', config.color)}
          >
            {node.kind}
          </span>
          <div
            className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColor)}
            title={node.status}
          />
        </div>
        <div className="text-[11px] font-semibold text-[var(--color-text)] truncate leading-tight">
          {node.name}
        </div>
        {node.namespace && (
          <div className="text-[9px] text-[var(--color-text-secondary)] truncate leading-none mt-0.5">
            {node.namespace}
          </div>
        )}
      </div>
      {node.canToggleCollapse && (
        <button
          type="button"
          className="nodrag nopan shrink-0 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]"
          onClick={(event) => {
            event.stopPropagation();
            node.onToggleCollapse(node.id);
          }}
          aria-label={node.collapsed ? `Expand ${node.kind} ${node.name}` : `Collapse ${node.kind} ${node.name}`}
          title={node.collapsed ? 'Expand descendants' : 'Collapse descendants'}
        >
          {node.collapsed ? <Plus size={11} strokeWidth={2.5} /> : <Minus size={11} strokeWidth={2.5} />}
        </button>
      )}
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: 'transparent', border: 'none', width: 6, height: 6 }}
      />
    </div>
  );
});
ResourceNode.displayName = 'ResourceNode';

const nodeTypes = { resourceNode: ResourceNode };

// ── Detail drawer ─────────────────────────────────────────────────────────────
interface DetailDrawerProps {
  node: ApiNode;
  onClose: () => void;
}

const DetailDrawer = ({ node, onClose }: DetailDrawerProps) => {
  const navigate = useNavigate();
  const config = KIND_CONFIG[node.kind] ?? KIND_CONFIG['Pod'];
  const Icon = config.icon;
  const dotColor = STATUS_DOT[node.status] ?? 'bg-neutral-400';

  return (
    <div className="w-60 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className={cn('p-1.5 rounded-md', config.bg)}>
            <Icon size={14} className={config.color} />
          </div>
          <span className={cn('text-[10px] font-bold uppercase tracking-wide', config.color)}>
            {node.kind}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-hover)] text-[var(--color-text-secondary)] transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div>
        <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">Name</div>
        <div className="text-[12px] font-semibold text-[var(--color-text)] break-all">
          {node.name}
        </div>
      </div>

      {node.namespace && (
        <div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">Namespace</div>
          <div className="text-[12px] text-[var(--color-text)]">{node.namespace}</div>
        </div>
      )}

      <div>
        <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">Status</div>
        <div className="flex items-center gap-1.5">
          <div className={cn('w-2 h-2 rounded-full shrink-0', dotColor)} />
          <span className="text-[12px] text-[var(--color-text)] capitalize">{node.status}</span>
        </div>
      </div>

      {config.navPath && (
        <button
          onClick={() => navigate(config.navPath!)}
          className="w-full text-[11px] px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-hover)] text-[var(--color-text-secondary)] transition-colors text-left"
        >
          View all {node.kind}s →
        </button>
      )}
    </div>
  );
};

// ── Main page ─────────────────────────────────────────────────────────────────
export const ResourceMapPage = () => {
  const { selectedNamespaces } = useNamespace();
  const nsParam = selectedNamespaces.join(',');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reactFlowRef = useRef<ReactFlowInstance<Node<ResourceFlowNodeData>, Edge> | null>(null);

  const [isExporting, setIsExporting] = useState(false);

  const REFRESH_INTERVAL = 15_000;

  const { data, isLoading, error, refetch } = useResourceMap(nsParam, {
    refetchInterval: REFRESH_INTERVAL,
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ResourceFlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<ApiNode | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [isSummaryPanelCollapsed, setIsSummaryPanelCollapsed] = useState(true);

  const toggleNodeCollapse = useCallback((nodeId: string) => {
    setCollapsedNodeIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const { rfNodes, rfEdges, visibleNodeIds } = useMemo(() => {
    if (!data) return { rfNodes: [], rfEdges: [], visibleNodeIds: new Set<string>() };
    const { visibleNodeIds: nextVisibleNodeIds, outgoing } = computeVisibleNodeIds(
      data.nodes,
      data.edges,
      collapsedNodeIds,
    );
    const visibleApiNodes = data.nodes.filter((node) => nextVisibleNodeIds.has(node.id));
    const visibleApiEdges = data.edges.filter(
      (edge) => nextVisibleNodeIds.has(edge.source) && nextVisibleNodeIds.has(edge.target),
    );

    const { rfNodes: nextRfNodes, rfEdges: nextRfEdges } = computeLayout(
      visibleApiNodes,
      visibleApiEdges,
      (node) => ({
        ...node,
        collapsed: collapsedNodeIds.has(node.id),
        canToggleCollapse: (outgoing.get(node.id)?.length ?? 0) > 0,
        onToggleCollapse: toggleNodeCollapse,
      }),
    );

    return {
      rfNodes: nextRfNodes,
      rfEdges: nextRfEdges,
      visibleNodeIds: nextVisibleNodeIds,
    };
  }, [collapsedNodeIds, data, toggleNodeCollapse]);

  useEffect(() => {
    if (!data) {
      setCollapsedNodeIds(new Set());
      return;
    }

    const validIds = new Set(data.nodes.map((node) => node.id));
    setCollapsedNodeIds((previous) => {
      let changed = false;
      const next = new Set<string>();

      previous.forEach((nodeId) => {
        if (validIds.has(nodeId)) {
          next.add(nodeId);
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [data]);

  useEffect(() => {
    if (selectedNode && !visibleNodeIds.has(selectedNode.id)) {
      setSelectedNode(null);
    }
  }, [selectedNode, visibleNodeIds]);

  useEffect(() => {
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [rfNodes, rfEdges, setNodes, setEdges]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as unknown as ApiNode);
  }, []);

  const handleRearrange = useCallback(() => {
    setSelectedNode(null);
    setNodes(rfNodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: { ...node.data },
    })));
    setEdges(rfEdges.map((edge) => ({
      ...edge,
      style: edge.style ? { ...edge.style } : edge.style,
      markerEnd: edge.markerEnd,
    })));

    requestAnimationFrame(() => {
      reactFlowRef.current?.fitView({ padding: 0.1, duration: 400 });
    });
  }, [rfEdges, rfNodes, setEdges, setNodes]);

  const handleExportImage = useCallback(async () => {
    if (!reactFlowRef.current || rfNodes.length === 0) {
      toast.error('No resource map available to export.');
      return;
    }

    const pane = containerRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
    if (!pane) {
      toast.error('Unable to locate resource map viewport.');
      return;
    }

    setIsExporting(true);

    const previousTransform = pane.style.transform;
    try {
      const bounds = getNodesBounds(rfNodes);
      const viewport = getViewportForBounds(bounds, bounds.width + 160, bounds.height + 160, 0.05, 3, 48);
      pane.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;

      const dataUrl = await toPng(pane, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0b1020',
      });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `resource-map-${stamp}.png`;
      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      link.click();
      toast.success('Resource map image exported.');
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : 'Failed to export resource map image.');
    } finally {
      pane.style.transform = previousTransform;
      setIsExporting(false);
      requestAnimationFrame(() => {
        reactFlowRef.current?.fitView({ padding: 0.1, duration: 0 });
      });
    }
  }, [rfNodes]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;

    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }

      if ('requestFullscreen' in el) {
        await el.requestFullscreen();
        return;
      }

      // Safari fallback
      const safariEl = el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
      if (typeof safariEl.webkitRequestFullscreen === 'function') {
        await safariEl.webkitRequestFullscreen();
      }
    } catch {
      // Ignore fullscreen errors; user gesture or browser policy may block it.
    }
  }, []);

  // Kind counts for the stats bar
  const stats = useMemo(() => {
    if (!data) return [];
    const map: Record<string, number> = {};
    data.nodes.forEach((n) => {
      map[n.kind] = (map[n.kind] ?? 0) + 1;
    });
    const order = Object.keys(KIND_CONFIG);
    return Object.entries(map).sort(
      (a, b) => order.indexOf(a[0]) - order.indexOf(b[0]),
    );
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <Loader size={24} className="text-primary animate-spin" />
          <p className="text-text-secondary text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-sm text-red-400">Failed to load resource map.</p>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-hover)]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-[var(--color-text-secondary)] gap-2">
        <p className="text-sm font-medium">No resources found</p>
        <p className="text-xs text-center max-w-xs">
          {selectedNamespaces.length === 0
            ? 'Select a namespace from the header filter to visualize resource relationships.'
            : 'No resources with relationships found in the selected namespace(s).'}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative', isFullscreen ? 'm-0' : '-m-4')}
      style={{ height: isFullscreen ? '100vh' : 'calc(100vh - 64px)' }}
    >
      <style>{`
        .resource-map-controls {
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
          overflow: hidden;
        }

        .resource-map-controls .react-flow__controls-button {
          background: var(--color-surface);
          border-bottom: 1px solid var(--color-border);
          color: var(--color-text-secondary);
        }

        .resource-map-controls .react-flow__controls-button:last-child {
          border-bottom: 0;
        }

        .resource-map-controls .react-flow__controls-button:hover {
          background: var(--color-hover);
          color: var(--color-text);
        }

        .resource-map-controls .react-flow__controls-button svg {
          fill: currentColor;
        }
      `}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={(instance) => {
          reactFlowRef.current = instance;
        }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelectedNode(null)}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.05}
        maxZoom={3}
        style={{ background: 'transparent' }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--color-border)"
        />
        <Controls
          className="resource-map-controls"
          position="bottom-right"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
          }}
        />
        <MiniMap
          position="bottom-left"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
          }}
          nodeColor={(node) => MINIMAP_COLOR[(node.data as unknown as ApiNode)?.kind] ?? '#6b7280'}
          maskColor="rgba(0,0,0,0.15)"
        />

        {/* Stats & legend panel */}
        <Panel position="top-left">
          <div className="flex flex-col gap-2" style={{ maxWidth: 480 }}>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
              <button
                type="button"
                onClick={() => setIsSummaryPanelCollapsed((value) => !value)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-hover)]"
                aria-expanded={!isSummaryPanelCollapsed}
                aria-label={isSummaryPanelCollapsed ? 'Expand resource map summary panel' : 'Collapse resource map summary panel'}
                title={isSummaryPanelCollapsed ? 'Expand panel' : 'Collapse panel'}
              >
                <span>Map summary</span>
                {isSummaryPanelCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>

              {!isSummaryPanelCollapsed && (
                <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-2">
                  {/* Kind counts */}
                  <div className="flex flex-wrap gap-1.5">
                    {stats.map(([kind, count]) => {
                      const cfg = KIND_CONFIG[kind];
                      if (!cfg) return null;
                      const Icon = cfg.icon;
                      return (
                        <div
                          key={kind}
                          className={cn(
                            'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold',
                            cfg.bg,
                            cfg.color,
                          )}
                        >
                          <Icon size={10} />
                          <span>
                            {kind}: {count}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Edge legend */}
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-sm space-y-1">
                    {([
                      { color: 'var(--color-border)',              label: 'owns (controller → workload)' },
                      { color: '#22c55e', dash: '4 2',             label: 'selects (Service → Pod)' },
                      { color: '#f97316', dash: '5 3',             label: 'routes (Ingress → Service)' },
                      { color: '#84cc16', dash: '6 2',             label: 'scales (HPA → workload)' },
                      { color: '#0ea5e9', dash: '4 3',             label: 'uses (Pod → ConfigMap/Secret)' },
                      { color: '#06b6d4', dash: '4 3',             label: 'uses_sa (Pod → ServiceAccount)' },
                      { color: '#8b5cf6',                          label: 'mounts (Pod → PVC)' },
                      { color: '#64748b', dash: '3 3',             label: 'binds (PVC → PV)' },
                    ] as Array<{ color: string; dash?: string; label: string }>).map(({ color, dash, label }) => (
                      <div key={label} className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                        <svg width="28" height="8" className="shrink-0">
                          <line x1="0" y1="4" x2="28" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray={dash} />
                          <polygon points="22,1 28,4 22,7" fill={color} />
                        </svg>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Panel>

        <Panel position="top-right">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRearrange}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] text-[11px] font-medium transition-colors shadow-sm"
              title="Rearrange nodes"
            >
              <RefreshCw size={12} />
              <span>Rearrange</span>
            </button>

            <button
              type="button"
              onClick={handleExportImage}
              disabled={isExporting}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] disabled:opacity-60 disabled:cursor-not-allowed text-[11px] font-medium transition-colors shadow-sm"
              title="Export map as PNG"
            >
              <Upload size={12} />
              <span>{isExporting ? 'Exporting...' : 'Export image'}</span>
            </button>

            {/* Fullscreen toggle */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] text-[11px] font-medium transition-colors shadow-sm"
            >
              {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              <span>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
            </button>
          </div>
        </Panel>
      </ReactFlow>

      {/* Node detail drawer — absolutely positioned outside ReactFlow */}
      {selectedNode && (
        <div className="absolute top-4 right-4 z-10">
          <DetailDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
        </div>
      )}
    </div>
  );
};
