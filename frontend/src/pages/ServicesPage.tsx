import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeServices } from '../hooks/useRealtimeResources';
import { deleteService } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, ServiceDetailPanel, ConfirmDialog } from '../components';
import { StatusBadge } from '../components/StatusBadge';
import type { Service } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';
import {
  getServiceExternalIpDisplay,
  getServiceStatus,
  getServiceStatusRank,
} from '../utils/serviceStatus';

type ServiceSortKey = 'name' | 'namespace' | 'status' | 'service_type' | 'cluster_ip' | 'external_ip' | 'ports' | 'age';

const sanitizeYamlForEdit = (yamlText: string) => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return yamlText;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      delete metadata.managedFields;
      delete metadata.resourceVersion;
      delete metadata.uid;
      delete metadata.generation;
      delete metadata.creationTimestamp;
      delete metadata.selfLink;
      const annotations = metadata.annotations as Record<string, unknown> | undefined;
      if (annotations) {
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

const getKey = (item: Service) => `${item.namespace}/${item.name}`;

export const ServicesPage = () => {
  const { data, isLoading, error } = useRealtimeServices();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedItem, setSelectedItem] = useState<Service | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: ServiceSortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleOpenYamlEditorFromPanel = async (item: Service) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/services/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const contentType = res.headers.get('content-type') || '';
      const yaml = await res.text();
      const looksLikeHtml = contentType.includes('text/html') || /^\s*<!doctype html/i.test(yaml) || /^\s*<html[\s>]/i.test(yaml);
      if (looksLikeHtml) throw new Error('Service YAML endpoint returned HTML instead of YAML');
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeYamlForEdit(yaml), title: item.name });
    } catch {
      openPanelTab({ type: 'yaml-editor', yamlContent: '# Failed to load service YAML\n', title: item.name });
    }
  };


  const handleDeleteSingle = async (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (!selectedRows.length) return;
    setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} services` });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(confirmDelete.keys.map((k) => { const [ns, n] = k.split('/'); return deleteService(ns, n); }));
      setSelectedRows([]); setConfirmDelete(null);
    } finally { setIsDeleting(false); }
  };

  const columns = [
    { header: 'Name', accessor: (row: Service) => <span className="font-medium text-text">{row.name}</span>, width: '18%', sortable: true, sortKey: 'name' },
    { header: 'Namespace', accessor: 'namespace' as const, width: '14%', sortable: true, sortKey: 'namespace' },
    {
      header: 'Status',
      accessor: (row: Service) => (
        <StatusBadge status={getServiceStatus(row)} />
      ),
      width: '16%',
      sortable: true,
      sortKey: 'status',
    },
    { header: 'Type', accessor: 'service_type' as const, width: '10%', sortable: true, sortKey: 'service_type' },
    { header: 'Cluster IP', accessor: 'cluster_ip' as const, width: '14%', sortable: true, sortKey: 'cluster_ip' },
    {
      header: 'External IP',
      accessor: (row: Service) => {
        const value = getServiceExternalIpDisplay(row);
        return (
          <span className={value === 'Pending allocation' ? 'text-dashboard-warning font-medium' : 'text-text'}>
            {value}
          </span>
        );
      },
      width: '16%',
      sortable: true,
      sortKey: 'external_ip',
    },
    { header: 'Ports', accessor: 'ports' as const, width: '16%', sortable: true, sortKey: 'ports' },
    { header: 'Age', accessor: (row: Service) => timeAgo(row.age), width: '12%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo((): (Service & { id: string })[] => {
    let src = [...(data || [])];
    if (selectedNamespaces.length > 0) src = src.filter((i) => selectedNamespaces.includes(i.namespace));
    if (resourceNameFilter.trim()) src = src.filter((i) => matchesResourceNameFilter(i.name, resourceNameFilter));
    const withId = src.map((i) => ({ ...i, id: getKey(i) }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      if (sortState.key === 'namespace') return a.namespace.localeCompare(b.namespace) * f;
      if (sortState.key === 'status') {
        const rank = (getServiceStatusRank(a) - getServiceStatusRank(b)) * f;
        if (rank !== 0) return rank;
        return a.name.localeCompare(b.name) * f;
      }
      if (sortState.key === 'service_type') return (a.service_type || '').localeCompare(b.service_type || '') * f;
      if (sortState.key === 'cluster_ip') return (a.cluster_ip || '').localeCompare(b.cluster_ip || '') * f;
      if (sortState.key === 'external_ip') {
        return getServiceExternalIpDisplay(a).localeCompare(getServiceExternalIpDisplay(b)) * f;
      }
      if (sortState.key === 'ports') return (a.ports || '').localeCompare(b.ports || '') * f;
      const at = Date.parse(a.age || ''); const bt = Date.parse(b.age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Services <span className="text-base font-normal text-text-secondary">(Manage Kubernetes services)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns}
          data={sortedData}
          isLoading={isLoading}
          error={error}
          rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? getKey(selectedItem) : undefined}
          sortState={sortState}
          onSortChange={(s) => setSortState(s as { key: ServiceSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true}
          selectedRows={selectedRows}
          onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <ServiceDetailPanel
            service={selectedItem}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditorFromPanel}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
          <div className="w-px h-4 bg-border" />
          <button type="button" onClick={handleDeleteSelected} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors">
            <Trash2 size={14} />Delete
          </button>
          <button type="button" onClick={() => setSelectedRows([])} className="text-xs text-text-secondary hover:text-text transition-colors">Clear</button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} services? This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
