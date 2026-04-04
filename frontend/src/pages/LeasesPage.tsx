import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from '../components/Icons';
import { useRealtimeLeases } from '../hooks/useRealtimeResources';
import { deleteLease } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable } from '../components/DataTable';
import { LeaseDetailPanel, ConfirmDialog } from '../components';
import type { Lease } from '../types';
import { timeAgo, matchesResourceNameFilter } from '../utils';

type LeaseSortKey = 'name' | 'namespace' | 'holder_identity' | 'lease_duration_seconds' | 'age';

export const LeasesPage = () => {
  const { data, isLoading, error } = useRealtimeLeases();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedLease, setSelectedLease] = useState<Lease | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: LeaseSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedLease(null);
      return;
    }

    if (!selectedLease) {
      setSelectedLease(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedLease.name && item.namespace === selectedLease.namespace
    );
    setSelectedLease(updatedSelected ?? data[0]);
  }, [data]);

  const handleDeleteSingle = async (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label:
        selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} leases`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteLease(ns, name);
        })
      );
      setSelectedRows([]);
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const sortedAndFilteredData = useMemo(() => {
    if (!data) return [];
    let filtered = data.filter(
      (lease) => selectedNamespaces.length === 0 || selectedNamespaces.includes(lease.namespace)
    );
    if (resourceNameFilter.trim()) {
      filtered = filtered.filter((lease) => matchesResourceNameFilter(lease.name, resourceNameFilter));
    }
    const sorted = [...filtered].map((item) => ({ ...item, id: `${item.namespace}/${item.name}` }));
    const factor = sortState.direction === 'asc' ? 1 : -1;
    const compareText = (left: unknown, right: unknown) =>
      String(left ?? '').localeCompare(String(right ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });

    sorted.sort((a, b) => {
      if (sortState.key === 'name') return compareText(a.name, b.name) * factor;
      if (sortState.key === 'namespace') {
        const result = compareText(a.namespace, b.namespace);
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'holder_identity') {
        const result = compareText(a.holder_identity, b.holder_identity);
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'lease_duration_seconds') {
        const result = (a.lease_duration_seconds || 0) - (b.lease_duration_seconds || 0);
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'age') {
        const aTime = Date.parse(a.age || '');
        const bTime = Date.parse(b.age || '');
        const aValue = Number.isNaN(aTime) ? 0 : aTime;
        const bValue = Number.isNaN(bTime) ? 0 : bTime;
        const result = aValue - bValue;
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      return 0;
    });

    return sorted;
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  const columns = [
    {
      header: 'Name',
      accessor: (lease: Lease) => <span className="font-medium text-text">{lease.name}</span>,
      width: '20%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '15%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Holder Identity',
      accessor: (lease: Lease) => (
        <span className="text-text-secondary text-sm font-mono">
          {lease.holder_identity || '-'}
        </span>
      ),
      width: '30%',
      sortable: true,
      sortKey: 'holder_identity',
    },
    {
      header: 'Duration (s)',
      accessor: 'lease_duration_seconds' as const,
      width: '15%',
      sortable: true,
      sortKey: 'lease_duration_seconds',
    },
    {
      header: 'Age',
      accessor: (lease: Lease) => timeAgo(lease.age),
      width: '15%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Leases <span className="text-base font-normal text-text-secondary">(Manage Kubernetes Leases)</span></h1>
      </div>

      <DataTable
        columns={columns}
        data={sortedAndFilteredData}
        rowKey="id"
        isLoading={isLoading}
        error={error}
        sortState={sortState}
        onSortChange={(newSort) =>
          setSortState(newSort as { key: LeaseSortKey; direction: 'asc' | 'desc' })
        }
        onRowClick={(row) => {
          setSelectedLease(row);
          setPanelOpen(true);
        }}
        selectedRowKey={
          panelOpen && selectedLease
            ? `${selectedLease.namespace}/${selectedLease.name}`
            : undefined
        }
        enableRowSelection={true}
        selectedRows={selectedRows}
        onRowSelectionChange={(rows) => setSelectedRows(rows)}
      />

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
          <div className="w-px h-4 bg-border" />
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors"
          >
            <Trash2 size={14} />
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelectedRows([])}
            className="text-xs text-text-secondary hover:text-text transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {panelOpen && selectedLease && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <LeaseDetailPanel
            lease={selectedLease}
            onClose={() => setPanelOpen(false)}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={
          confirmDelete && confirmDelete.keys.length === 1
            ? `Are you sure you want to delete "${confirmDelete.label}"? This action cannot be undone.`
            : `Are you sure you want to delete ${confirmDelete?.keys.length} leases? This action cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
