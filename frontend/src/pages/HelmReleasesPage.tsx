import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import YAML from 'yaml';
import { toast } from 'sonner';
import { Trash2 } from '../components/Icons';
import { useHelmReleases, deleteHelmRelease, getHelmReleaseYaml } from '../hooks/useKubernetes';
import { DataTable } from '../components/DataTable';
import { HelmReleaseDetailPanel } from '../components/HelmReleaseDetailPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { openPanelTab } from '../components/BottomPanel';
import { timeAgo } from '../utils';
import type { HelmRelease } from '../types';

type ReleaseSortKey = 'name' | 'namespace' | 'chart' | 'revision' | 'status' | 'updated';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneValue(v);
    }
    return out;
  }
  return value;
};

const deepMergeRecords = (
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> => {
  const out = cloneValue(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(overlay)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMergeRecords(existing, v);
      continue;
    }
    // Arrays and scalars from overlay should replace base values.
    out[k] = cloneValue(v);
  }
  return out;
};

const parseValuesCandidate = (value: unknown): Record<string, unknown> | null => {
  const obj = asRecord(value);
  if (obj) return obj;

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  try {
    const parsed = YAML.parse(text);
    const parsedObj = asRecord(parsed);
    if (parsedObj) return parsedObj;

    // Some releases keep values as a JSON/YAML string within another string.
    if (typeof parsed === 'string') {
      const nested = asRecord(YAML.parse(parsed));
      if (nested) return nested;
    }
  } catch {
    return null;
  }

  return null;
};

const asTextValuesCandidate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
};

const extractHelmValuesYaml = (yamlText: string) => {
  try {
    const parsed = asRecord(YAML.parse(yamlText));
    if (!parsed) {
      return yamlText;
    }

    const chart = asRecord(parsed.chart);
    const info = asRecord(parsed.info);

    const chartDefaults = parseValuesCandidate(chart?.values);
    const releaseOverrides = parseValuesCandidate(parsed.config);
    const releaseValues = parseValuesCandidate(parsed.values) ?? parseValuesCandidate(info?.values);

    if (chartDefaults && releaseOverrides) {
      const mergedValues = deepMergeRecords(chartDefaults, releaseOverrides);
      return YAML.stringify(mergedValues, { lineWidth: 0 });
    }

    if (releaseValues) {
      return YAML.stringify(releaseValues, { lineWidth: 0 });
    }

    if (releaseOverrides) {
      return YAML.stringify(releaseOverrides, { lineWidth: 0 });
    }

    if (chartDefaults) {
      return YAML.stringify(chartDefaults, { lineWidth: 0 });
    }

    const candidates: unknown[] = [
      parsed.values,
      info?.values,
      parsed.config,
      chart?.values,
    ];

    for (const candidate of candidates) {
      const valuesObj = parseValuesCandidate(candidate);
      if (valuesObj) {
        return YAML.stringify(valuesObj, { lineWidth: 0 });
      }

      const valuesText = asTextValuesCandidate(candidate);
      if (valuesText) {
        return valuesText.endsWith('\n') ? valuesText : `${valuesText}\n`;
      }
    }

    return yamlText;
  } catch {
    return yamlText;
  }
};

const getStatusClass = (status: string) => {
  const s = status.toLowerCase();
  if (s === 'deployed') return 'status-green';
  if (s === 'failed') return 'status-red';
  if (s.startsWith('pending') || s === 'uninstalling') return 'status-yellow';
  if (s === 'superseded' || s === 'uninstalled') return 'status-gray';
  return 'status-gray';
};

/** Helm release lifecycle description for tooltip. */
const getLifecycleDescription = (status: string): string => {
  const s = status.toLowerCase();
  switch (s) {
    case 'deployed':
      return 'Release is active and running.';
    case 'pending-install':
      return 'Install is in progress.';
    case 'pending-upgrade':
      return 'Upgrade is in progress.';
    case 'pending-rollback':
      return 'Rollback is in progress.';
    case 'uninstalling':
      return 'Uninstall is in progress (helm uninstall).';
    case 'uninstalled':
      return 'Release has been uninstalled.';
    case 'failed':
      return 'Release install, upgrade, or rollback failed.';
    case 'superseded':
      return 'Superseded by a newer revision.';
    default:
      return 'Release lifecycle state.';
  }
};

export const HelmReleasesPage = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useHelmReleases();
  const [selectedRelease, setSelectedRelease] = useState<HelmRelease | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: ReleaseSortKey; direction: 'asc' | 'desc' }>({
    key: 'name',
    direction: 'asc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedRelease(null);
      return;
    }
    if (!selectedRelease) {
      setSelectedRelease(data[0]);
      return;
    }
    const updated = data.find(
      (r) => r.name === selectedRelease.name && r.namespace === selectedRelease.namespace,
    );
    setSelectedRelease(updated ?? data[0]);
  }, [data]);

  const handleOpenYaml = async (release: HelmRelease) => {
    setPanelOpen(false);
    try {
      const yaml = await getHelmReleaseYaml(release.namespace, release.name);
      const valuesYaml = extractHelmValuesYaml(yaml);
      openPanelTab({
        type: 'yaml-editor',
        yamlContent: valuesYaml,
        title: `${release.name} values`,
        yamlActionLabel: 'Upgrade',
        helmReleaseName: release.name,
        helmReleaseNamespace: release.namespace,
      });
    } catch {
      openPanelTab({
        type: 'yaml-editor',
        yamlContent: '# Failed to load Helm values\n',
        title: `${release.name} values`,
        yamlActionLabel: 'Upgrade',
        helmReleaseName: release.name,
        helmReleaseNamespace: release.namespace,
      });
    }
  };

  const handleDeleteSingle = (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label:
        selectedRows.length === 1
          ? selectedRows[0].split('/')[1]
          : `${selectedRows.length} releases`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteHelmRelease(ns, name);
        }),
      );
      toast.success(
        confirmDelete.keys.length === 1
          ? `Release '${confirmDelete.keys[0].split('/')[1]}' uninstalled.`
          : `${confirmDelete.keys.length} releases uninstalled.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['helm-releases'] });
      setSelectedRows([]);
      setConfirmDelete(null);
      setPanelOpen(false);
      setSelectedRelease(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Uninstall failed';
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  const columns = [
    {
      header: 'Name',
      accessor: (row: HelmRelease) => (
        <span className="font-medium text-text">{row.name}</span>
      ),
      width: '16%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: (row: HelmRelease) => (
        <span className="font-mono text-text-secondary">{row.namespace}</span>
      ),
      width: '12%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Chart',
      accessor: (row: HelmRelease) => (
        <span className="text-text">{row.chart !== '-' ? row.chart : row.name}</span>
      ),
      width: '14%',
      sortable: true,
      sortKey: 'chart',
    },
    {
      header: 'Revision',
      accessor: (row: HelmRelease) => (
        <span className="text-text-secondary">{row.revision}</span>
      ),
      width: '8%',
      sortable: true,
      sortKey: 'revision',
    },
    {
      header: 'Version',
      accessor: (row: HelmRelease) => (
        <span className="font-mono text-text-secondary">{row.chart_version}</span>
      ),
      width: '10%',
    },
    {
      header: 'App Version',
      accessor: (row: HelmRelease) => (
        <span className="font-mono text-text-secondary">{row.app_version}</span>
      ),
      width: '10%',
    },
    {
      header: 'Status',
      accessor: (row: HelmRelease) => (
        <span
          className={`inline-flex px-2.5 py-0.5 rounded-full font-medium ${getStatusClass(row.status)}`}
          title={getLifecycleDescription(row.status)}
        >
          {row.status}
        </span>
      ),
      width: '12%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Updated',
      accessor: (row: HelmRelease) => (
        <span className="text-text-secondary">
          {row.updated ? timeAgo(row.updated) : '-'}
        </span>
      ),
      width: '18%',
      sortable: true,
      sortKey: 'updated',
    },
  ];

  const sortedReleases = useMemo(() => {
    const source = [...(data || [])];
    const factor = sortState.direction === 'asc' ? 1 : -1;
    const compareText = (a: unknown, b: unknown) =>
      String(a ?? '').localeCompare(String(b ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });

    return source.sort((a, b) => {
      switch (sortState.key) {
        case 'revision':
          return ((a.revision ?? 0) - (b.revision ?? 0)) * factor;
        case 'updated': {
          const ta = a.updated ? Date.parse(a.updated) : 0;
          const tb = b.updated ? Date.parse(b.updated) : 0;
          const diff = (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
          return (diff !== 0 ? diff : compareText(a.name, b.name)) * factor;
        }
        case 'status':
          return (compareText(a.status, b.status) || compareText(a.name, b.name)) * factor;
        case 'namespace':
          return (compareText(a.namespace, b.namespace) || compareText(a.name, b.name)) * factor;
        case 'chart':
          return (compareText(a.chart, b.chart) || compareText(a.name, b.name)) * factor;
        default:
          return compareText(a.name, b.name) * factor;
      }
    });
  }, [data, sortState]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">
          Releases{' '}
          <span className="text-base font-normal text-text-secondary">
            (Installed Helm releases)
          </span>
        </h1>
      </div>

      <DataTable
        columns={columns}
        data={sortedReleases}
        isLoading={isLoading}
        error={error?.message ?? null}
        autoFitContent={false}
        rowKey={(row) => `${row.namespace}/${row.name}`}
        onRowClick={(row) => {
          setSelectedRelease(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen ? `${selectedRelease?.namespace}/${selectedRelease?.name}` : undefined}
        sortState={sortState}
        onSortChange={(next) =>
          setSortState(next as { key: ReleaseSortKey; direction: 'asc' | 'desc' })
        }
        enableRowSelection
        selectedRows={selectedRows}
        onRowSelectionChange={(rows) => setSelectedRows(rows)}
      />

      {/* Right detail panel */}
      {panelOpen && selectedRelease && (
        <>
          <div
            className="fixed inset-0 z-[95] bg-black/20"
            onClick={() => setPanelOpen(false)}
          />
          <HelmReleaseDetailPanel
            release={selectedRelease}
            onClose={() => setPanelOpen(false)}
            onOpenYaml={handleOpenYaml}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {/* Bulk action bar */}
      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">
            {selectedRows.length} selected
          </span>
          <div className="w-px h-4 bg-border" />
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors"
          >
            <Trash2 size={14} />
            Uninstall
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

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Uninstall Helm Release"
        description={`Uninstall "${confirmDelete?.label}"? This will remove all Kubernetes resources managed by this release.`}
        confirmLabel="Uninstall"
        destructive
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
