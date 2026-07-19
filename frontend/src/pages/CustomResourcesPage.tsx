import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import YAML from 'yaml';
import { ChevronDown, Layers, Pencil, Trash2 } from '../components/Icons';
import { deleteCustomResource } from '../hooks/useKubernetes';
import { useRealtimeCrds, useRealtimeCustomResources } from '../hooks/useRealtimeResources';
import { useSyncSelectedRealtimeItem } from '../hooks/useSyncSelectedRealtimeItem';
import { DataTable } from '../components';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ResourceDetailPanelLayout, PanelActionButton } from '../components/ResourceDetailPanelLayout';
import { DrawerItem, DrawerTitle, DrawerParamToggler, DrawerLabelsAnnotations } from '../components/drawer';
import { useNamespace } from '../context/NamespaceContext';
import { openPanelTab } from '../components/BottomPanel';
import { timeAgo, safeJsonPathValue, formatJsonValue, matchesResourceNameFilter } from '../utils';
import { getAuthToken } from '../utils/auth';
import type { CustomResource, Crd, CrdPrinterColumn } from '../types';

/**
 * Build a K8s-like object from CustomResource for JSONPath resolution (matches Freelens / kubectl).
 * Must include metadata (name, namespace, creationTimestamp, labels, annotations), spec, and status
 * so CRD printer column paths like .metadata.labels, .spec.addresses, .status.conditions resolve.
 */
function resourceObjectForJsonPath(item: CustomResource): Record<string, unknown> {
  return {
    metadata: {
      name: item.name,
      namespace: item.namespace ?? '',
      creationTimestamp: item.created_at ?? null,
      labels: item.labels ?? {},
      annotations: item.annotations ?? {},
    },
    spec: item.spec ?? {},
    status: item.status ?? {},
  };
}

const sanitizeCrdYamlForEdit = (yamlText: string): string => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return yamlText;

    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata === 'object') {
      delete metadata.managedFields;
      delete metadata.resourceVersion;
      delete metadata.uid;
      delete metadata.generation;
      delete metadata.creationTimestamp;
      delete metadata.selfLink;

      const annotations = metadata.annotations as Record<string, unknown> | undefined;
      if (annotations && typeof annotations === 'object') {
        delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
        if (Object.keys(annotations).length === 0) delete metadata.annotations;
      }
    }

    delete parsed.status;

    return YAML.stringify(parsed, { lineWidth: 0 });
  } catch {
    return yamlText;
  }
};

const JsonTree = ({ value, depth = 0 }: { value: unknown; depth?: number }) => {
  const [expanded, setExpanded] = useState(depth < 2);

  if (value === null || value === undefined) {
    return <span className="text-text-secondary">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-green-400' : 'text-red-400'}>{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-blue-400">{value}</span>;
  }
  if (typeof value === 'string') {
    return <span className="text-yellow-300">"{value}"</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-text-secondary">[]</span>;
    return (
      <span>
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className="inline-flex items-center gap-0.5 text-text-secondary hover:text-text"
        >
          <ChevronDown size={12} className={expanded ? '' : '-rotate-90'} />
          [{value.length}]
        </button>
        {expanded && (
          <div className="ml-4 border-l border-border pl-2">
            {value.map((item, i) => (
              <div key={i} className="py-0.5">
                <span className="text-text-secondary">{i}: </span>
                <JsonTree value={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-text-secondary">{'{}'}</span>;
    return (
      <span>
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className="inline-flex items-center gap-0.5 text-text-secondary hover:text-text"
        >
          <ChevronDown size={12} className={expanded ? '' : '-rotate-90'} />
          {'{'}...{'}'}
        </button>
        {expanded && (
          <div className="ml-4 border-l border-border pl-2">
            {entries.map(([k, v]) => (
              <div key={k} className="py-0.5">
                <span className="text-primary">{k}</span>
                <span className="text-text-secondary">: </span>
                <JsonTree value={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }
  return <span>{String(value)}</span>;
};

/**
 * Render printer column value for detail panel (Freelens-style: arrays as list, objects as JSON block).
 */
function convertSpecValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc list-inside pl-1 space-y-0.5 text-xs" style={{ color: 'var(--color-text)' }}>
        {value.map((item, index) => (
          <li key={index}>{convertSpecValue(item)}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') {
    return (
      <pre className="text-xs whitespace-pre-wrap break-words mt-1 p-2 rounded border border-border bg-surface-elevated overflow-x-auto" style={{ color: 'var(--color-text)' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value);
}

/**
 * Humanize CRD column name for display: add spaces before capitals but keep trailing
 * acronyms together (e.g. "InternalIP" -> "Internal IP", "CiliumInternalIP" -> "Cilium Internal IP").
 */
function humanizeColumnName(name: string): string {
  if (!name) return name;
  const withSpaces = name.replace(/([A-Z])/g, ' $1').trim();
  // Merge trailing " I P" or " A P I" into " IP", " API"
  return withSpaces.replace(/( [A-Z])+$/g, (m) => ' ' + m.replace(/\s/g, '')).trim();
}

/** Resolve jsonPath from printer column (API may send jsonPath or json_path) */
function getPrinterColumnJsonPath(col: CrdPrinterColumn & { json_path?: string }): string {
  return col.jsonPath ?? col.json_path ?? '';
}

const DetailPanel = ({
  item,
  crd,
  onClose,
  onEditYaml,
  onDelete,
}: {
  item: CustomResource;
  crd: Crd | undefined;
  onClose: () => void;
  onEditYaml: (item: CustomResource) => void;
  onDelete: (item: CustomResource) => void;
}) => {
  const resourceObj = resourceObjectForJsonPath(item);
  const printerColumns = crd?.printer_columns ?? [];
  const conditions = (item.status && typeof item.status === 'object' && Array.isArray((item.status as Record<string, unknown>).conditions))
    ? (item.status as Record<string, unknown>).conditions as Array<{ type?: string; status?: string; reason?: string }>
    : [];

  const actions = (
    <>
      <PanelActionButton icon={Pencil} label="Edit YAML" onClick={() => onEditYaml(item)} />
      <PanelActionButton icon={Trash2} label="Delete" onClick={() => onDelete(item)} danger />
    </>
  );

  return (
    <>
      <div
        className="fixed inset-0 z-[110] bg-black/20"
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        aria-hidden="true"
        role="presentation"
      />
      <div className="fixed right-0 top-0 bottom-0 z-[120]" onClick={(e) => e.stopPropagation()}>
        <ResourceDetailPanelLayout
          kind={crd?.kind ?? 'Custom Resource'}
          kindIcon={Layers}
          title={item.name}
          keyInfo={[
            ...(item.namespace ? [{ label: 'Namespace', value: item.namespace }] : []),
            { label: 'Age', value: timeAgo(item.created_at) },
          ]}
          actions={actions}
          onClose={onClose}
        >
          <DrawerTitle>Property</DrawerTitle>
          <DrawerItem name="Name">{item.name}</DrawerItem>
          {item.namespace ? <DrawerItem name="Namespace">{item.namespace}</DrawerItem> : null}
          <DrawerItem name="Age">{timeAgo(item.created_at)}</DrawerItem>
          <DrawerLabelsAnnotations labels={item.labels ?? undefined} annotations={item.annotations ?? undefined} />
          {printerColumns.length > 0 && <DrawerTitle>Columns</DrawerTitle>}
          {printerColumns.map((col) => {
            const value = safeJsonPathValue(resourceObj, getPrinterColumnJsonPath(col));
            return (
              <DrawerItem key={col.name} name={humanizeColumnName(col.name)}>
                {convertSpecValue(value)}
              </DrawerItem>
            );
          })}
          {conditions.length > 0 ? (
            <>
              <DrawerTitle>Conditions</DrawerTitle>
              {conditions.map((c, i) => (
                <DrawerItem key={i} name={c.type ?? 'Condition'}>
                  {c.status === 'True' ? 'True' : c.status === 'False' ? 'False' : (c.reason ?? String(c.status))}
                </DrawerItem>
              ))}
            </>
          ) : null}
          <DrawerParamToggler label="Spec">
            <div className="py-2 font-mono text-xs overflow-x-auto">
              <JsonTree value={item.spec} />
            </div>
          </DrawerParamToggler>
          {item.status && Object.keys(item.status).length > 0 && (
            <DrawerParamToggler label="Status" className="pt-1">
              <div className="py-2 font-mono text-xs overflow-x-auto">
                <JsonTree value={item.status} />
              </div>
            </DrawerParamToggler>
          )}
        </ResourceDetailPanelLayout>
      </div>
    </>
  );
};

type SortKey = 'name' | 'namespace' | 'age' | string;

const customResourceKey = (item: CustomResource) =>
  item.namespace ? `${item.namespace}/${item.name}` : item.name;

export const CustomResourcesPage = () => {
  const { crdName } = useParams<{ crdName: string }>();
  const decodedCrdName = crdName ? decodeURIComponent(crdName) : '';

  const { data: crds, isLoading: crdsLoading } = useRealtimeCrds();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();

  const crd = crds?.find((c) => c.name === decodedCrdName);
  const isNamespaced = crd?.scope === 'Namespaced';

  const { data: realtimeData, isLoading: resourcesLoading, error } = useRealtimeCustomResources(decodedCrdName || null);
  const rawData = realtimeData ?? [];
  // Wait for both CRD definitions and custom resource stream to avoid first paint flicker.
  const isLoading = Boolean(decodedCrdName && (resourcesLoading || crdsLoading));
  // For namespaced CRDs filter by selected namespaces when set
  const data = useMemo(() => {
    if (!rawData?.length) return rawData ?? [];
    if (!isNamespaced || selectedNamespaces.length === 0) return rawData;
    return rawData.filter((item) => item.namespace && selectedNamespaces.includes(item.namespace));
  }, [rawData, isNamespaced, selectedNamespaces]);

  const [selectedItem, setSelectedItem] = useState<CustomResource | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CustomResource | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Close panel when navigating to a different CRD
  useEffect(() => {
    setPanelOpen(false);
    setSelectedItem(null);
    setConfirmDelete(null);
  }, [decodedCrdName]);

  useSyncSelectedRealtimeItem(
    rawData,
    panelOpen && selectedItem ? customResourceKey(selectedItem) : null,
    selectedItem,
    setSelectedItem,
    customResourceKey,
    panelOpen,
  );

  const handleEditYaml = async (item: CustomResource) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const params = item.namespace ? `?namespace=${encodeURIComponent(item.namespace)}` : '';
      const res = await fetch(
        `/api/crds/${encodeURIComponent(decodedCrdName)}/resources/${encodeURIComponent(item.name)}/yaml${params}`,
        { headers: token ? { Authorization: token } : {} }
      );
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeCrdYamlForEdit(yaml), title: item.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await deleteCustomResource(decodedCrdName, confirmDelete.name, confirmDelete.namespace ?? undefined);
      setConfirmDelete(null);
      setPanelOpen(false);
      setSelectedItem(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const [sortState, setSortState] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  const printerColumns = crd?.printer_columns ?? [];
  const hasPrinterColumns = printerColumns.length > 0;

  const columns = useMemo(() => {
    const base = [
      { header: 'Name', accessor: 'name' as const, width: '25%', sortable: true, sortKey: 'name' as SortKey },
      ...(isNamespaced
        ? [
            {
              header: 'Namespace',
              accessor: 'namespace' as const,
              width: '15%',
              sortable: true,
              sortKey: 'namespace' as SortKey,
            },
          ]
        : []),
      ...(hasPrinterColumns
        ? printerColumns.map((col: CrdPrinterColumn) => ({
            header: humanizeColumnName(col.name),
            accessor: (r: CustomResource) => {
              const obj = resourceObjectForJsonPath(r);
              return formatJsonValue(safeJsonPathValue(obj, getPrinterColumnJsonPath(col)));
            },
            width: '15%' as const,
            sortable: true,
            sortKey: col.name as SortKey,
          }))
        : [
            {
              header: 'Spec keys',
              accessor: (r: CustomResource) =>
                r.spec && typeof r.spec === 'object' ? Object.keys(r.spec).join(', ') || '-' : '-',
              width: '20%' as const,
              sortKey: 'spec_keys' as SortKey,
            },
          ]),
      {
        header: 'Age',
        accessor: (r: CustomResource) => (r.created_at ? timeAgo(r.created_at) : '-'),
        width: hasPrinterColumns ? '12%' : '20%',
        sortable: true,
        sortKey: 'age' as SortKey,
      },
    ];
    return base;
  }, [crd?.printer_columns, isNamespaced, hasPrinterColumns, printerColumns]);

  // Apply namespace and name filter client-side
  const filtered = useMemo(() => {
    if (!data) return [];
    let out = data;
    if (isNamespaced && selectedNamespaces.length > 0) {
      out = out.filter((r) => !r.namespace || selectedNamespaces.includes(r.namespace));
    }
    if (resourceNameFilter.trim()) {
      out = out.filter((r) => matchesResourceNameFilter(r.name, resourceNameFilter));
    }
    return out;
  }, [data, isNamespaced, selectedNamespaces, resourceNameFilter]);

  const sortedData = useMemo(() => {
    const f = sortState.direction === 'asc' ? 1 : -1;
    const sortKey = sortState.key;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name) * f;
      if (sortKey === 'namespace')
        return (a.namespace ?? '').localeCompare(b.namespace ?? '') * f;
      if (sortKey === 'age' || sortKey === 'spec_keys') {
        const at = Date.parse(a.created_at ?? '');
        const bt = Date.parse(b.created_at ?? '');
        return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
      }
      const printerCol = printerColumns.find((c) => c.name === sortKey);
      if (printerCol) {
        const path = getPrinterColumnJsonPath(printerCol);
        const objA = resourceObjectForJsonPath(a);
        const objB = resourceObjectForJsonPath(b);
        const valA = safeJsonPathValue(objA, path);
        const valB = safeJsonPathValue(objB, path);
        const strA = formatJsonValue(valA);
        const strB = formatJsonValue(valB);
        return strA.localeCompare(strB, undefined, { numeric: true }) * f;
      }
      return 0;
    });
  }, [filtered, sortState, printerColumns]);

  const withId = sortedData.map((r) => ({ ...r, id: `${r.name}/${r.namespace ?? ''}` }));

  const title = crd ? `${crd.kind} (${crd.group})` : decodedCrdName;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">
          {title}
          {crd && (
            <span className="ml-2 text-sm font-normal text-text-secondary">
              ({crd.scope})
            </span>
          )}
        </h1>
      </div>
      <div className="space-y-2">
        <DataTable
          columns={columns}
          data={withId}
          isLoading={isLoading}
          error={error ? String(error) : null}
          rowKey="id"
          selectedRowKey={
            selectedItem ? `${selectedItem.name}/${selectedItem.namespace ?? ''}` : undefined
          }
          onRowClick={(row) => {
            setSelectedItem(row);
            setPanelOpen(true);
          }}
          sortState={sortState}
          onSortChange={(s) => setSortState(s as { key: SortKey; direction: 'asc' | 'desc' })}
        />
      </div>
      {panelOpen && selectedItem && (
        <DetailPanel
          item={selectedItem}
          crd={crd}
          onClose={() => setPanelOpen(false)}
          onEditYaml={handleEditYaml}
          onDelete={(item) => setConfirmDelete(item)}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete resource"
        description={`Are you sure you want to delete "${confirmDelete?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
