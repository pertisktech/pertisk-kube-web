import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog, DataTable } from '../components';
import { StatusBadge } from '../components/StatusBadge';
import { Trash2 } from '../components/Icons';
import { deleteBackupRunsBulk, downloadBackupRun, runRestoreBackup, useBackupOverview } from '../hooks/useKubernetes';
import type { BackupOverview, BackupRecord } from '../types';
import { formatBytes, timeAgo } from '../utils';

const STANDARD_ACTION_BASE = 'inline-flex items-center whitespace-nowrap px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40';
const STANDARD_ACTION_NEUTRAL = `${STANDARD_ACTION_BASE} border border-border bg-surface text-text-secondary hover:bg-hover hover:text-text`;
const STANDARD_ACTION_DANGER = `${STANDARD_ACTION_BASE} border border-[var(--color-icon-danger)]/30 bg-[var(--color-icon-danger)]/5 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/15`;

const formatBackupSize = (sizeBytes?: number | null): string => {
  if (sizeBytes == null || sizeBytes <= 0) return '-';
  return formatBytes(sizeBytes);
};

export const BackupListPage = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useBackupOverview();
  const backups = useMemo(() => data?.backups ?? [], [data]);
  const [nameFilter, setNameFilter] = useState('');
  const filteredBackups = useMemo(
    () => nameFilter.trim() ? backups.filter((b) => b.name.toLowerCase().includes(nameFilter.toLowerCase())) : backups,
    [backups, nameFilter],
  );
  const [selectedBackup, setSelectedBackup] = useState<BackupRecord | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [restoringName, setRestoringName] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<BackupRecord | null>(null);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);

  const handleDeleteSelected = () => {
    if (!selectedRows.length || deletingName || isDeleting) return;
    setConfirmDelete({
      keys: selectedRows,
      label: selectedRows.length === 1 ? selectedRows[0] : `${selectedRows.length} backups`,
    });
  };

  const handleConfirmRestore = async () => {
    if (!confirmRestore) return;
    setRestoringName(confirmRestore.name);
    setConfirmRestore(null);
    try {
      const restoreName = await runRestoreBackup({ backup_name: confirmRestore.name });
      await queryClient.invalidateQueries({ queryKey: ['backup-overview'] });
      toast.success(`Restore triggered: ${restoreName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to trigger restore.');
    } finally {
      setRestoringName(null);
    }
  };

  const handleConfirmDelete = () => {
    if (!confirmDelete) return;

    const request = { ...confirmDelete };
    setConfirmDelete(null);
    setIsDeleting(true);
    setDeletingName(request.keys[0] || null);

    // Close immediately and optimistically remove rows so users can continue
    // using the page while S3 cleanup runs in the background.
    queryClient.setQueryData(['backup-overview'], (current: BackupOverview | undefined) => {
      if (!current) return current;
      return {
        ...current,
        backups: current.backups.filter((backup) => !request.keys.includes(backup.name)),
      };
    });

    if (selectedBackup && request.keys.includes(selectedBackup.name)) {
      setPanelOpen(false);
      setSelectedBackup(null);
    }

    setSelectedRows((previous) => previous.filter((name) => !request.keys.includes(name)));

    const loadingToastId = toast.loading(
      request.keys.length === 1
        ? `Deleting backup ${request.keys[0]} in background...`
        : `Deleting ${request.keys.length} backups in background...`
    );

    void (async () => {
      try {
        const result = await deleteBackupRunsBulk(request.keys);
        toast.success(
          result.message ||
            (request.keys.length === 1
              ? `Deleted backup ${request.keys[0]}`
              : `Deleted ${request.keys.length} backups`),
          { id: loadingToastId }
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete backups', { id: loadingToastId });
      } finally {
        await queryClient.invalidateQueries({ queryKey: ['backup-overview'] });
        setDeletingName(null);
        setIsDeleting(false);
      }
    })();
  };

  const handleDownload = async (backupName: string) => {
    if (downloadingName) return;
    setDownloadingName(backupName);
    try {
      await downloadBackupRun(backupName);
      toast.success(`Download started: ${backupName}.json`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to download backup');
    } finally {
      setDownloadingName(null);
    }
  };

  const formatNamespaces = (values: string[], emptyLabel: string) => {
    if (!values || values.length === 0) {
      return emptyLabel;
    }
    return values.join(', ');
  };

  const formatKindLabel = (kind: string) => kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const columns = [
    {
      header: 'Name',
      accessor: (row: BackupRecord) => <span className="font-medium text-text">{row.name}</span>,
      width: '32%',
    },
    { header: 'Phase', accessor: (row: BackupRecord) => <StatusBadge status={row.phase} />, width: '16%' },
    {
      header: 'Size',
      accessor: (row: BackupRecord) => formatBackupSize(row.size_bytes),
      width: '10%',
    },
    { header: 'Storage', accessor: (row: BackupRecord) => row.storage_location, width: '18%' },
    { header: 'Created', accessor: (row: BackupRecord) => timeAgo(row.created_at), width: '14%' },
    {
      header: 'Actions',
      accessor: () => '-',
      width: '260px',
      render: (row: BackupRecord) => (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (restoringName) return;
              setConfirmRestore(row);
            }}
            disabled={restoringName === row.name}
            className={STANDARD_ACTION_NEUTRAL}
          >
            {restoringName === row.name ? 'Restoring...' : 'Restore'}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleDownload(row.name);
            }}
            disabled={downloadingName === row.name}
            className={STANDARD_ACTION_NEUTRAL}
          >
            {downloadingName === row.name ? 'Downloading...' : 'Download'}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (deletingName || isDeleting) return;
              setConfirmDelete({ keys: [row.name], label: row.name });
            }}
            disabled={deletingName === row.name || isDeleting}
            className={STANDARD_ACTION_DANGER}
          >
            {deletingName === row.name || isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Backups</h1>
          <p className="text-sm text-text-secondary">Recent backup resources and phases.</p>
        </div>

        <input
          type="text"
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          placeholder="Filter by name..."
          className="w-full md:w-64 rounded-md border border-border bg-surface px-3 py-2 text-sm"
        />
      </div>

      <DataTable
        columns={columns}
        data={filteredBackups}
        rowKey="name"
        isLoading={isLoading}
        error={error ? String(error) : null}
        autoFitContent={false}
        onRowClick={(row) => {
          setSelectedBackup(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen && selectedBackup ? selectedBackup.name : undefined}
        enableRowSelection={true}
        selectedRows={selectedRows}
        onRowSelectionChange={setSelectedRows}
      />

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
          <div className="w-px h-4 bg-border" />
          <button
            type="button"
            onClick={handleDeleteSelected}
            disabled={isDeleting || deletingName !== null}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} />Delete
          </button>
          <button
            type="button"
            onClick={() => setSelectedRows([])}
            disabled={isDeleting || deletingName !== null}
            className="text-xs text-text-secondary hover:text-text transition-colors disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}

      {panelOpen && selectedBackup && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-full max-w-xl bg-surface border-l border-border shadow-2xl z-[100] flex flex-col">
            <div className="px-6 py-4 border-b border-border bg-surface-elevated flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-text">Backup Detail</h2>
                <p className="text-sm text-text-secondary">{selectedBackup.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-border text-sm text-text-secondary hover:text-text hover:bg-hover transition-colors"
              >
                Close
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-4 bg-surface-elevated">
                  <p className="text-xs uppercase tracking-wide text-text-secondary">Phase</p>
                  <p className="mt-1 text-sm font-medium text-text">{selectedBackup.phase}</p>
                </div>
                <div className="rounded-lg border border-border p-4 bg-surface-elevated">
                  <p className="text-xs uppercase tracking-wide text-text-secondary">Size</p>
                  <p className="mt-1 text-sm font-medium text-text">{formatBackupSize(selectedBackup.size_bytes)}</p>
                </div>
                <div className="rounded-lg border border-border p-4 bg-surface-elevated">
                  <p className="text-xs uppercase tracking-wide text-text-secondary">Created</p>
                  <p className="mt-1 text-sm font-medium text-text">{timeAgo(selectedBackup.created_at)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-border p-4 bg-surface-elevated">
                <p className="text-xs uppercase tracking-wide text-text-secondary">Storage Location</p>
                <p className="mt-1 text-sm text-text break-all">{selectedBackup.storage_location || '-'}</p>
              </div>

              <div className="rounded-lg border border-border p-4 bg-surface-elevated space-y-3">
                <p className="text-xs uppercase tracking-wide text-text-secondary">Namespace</p>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-text-secondary">Include</p>
                  <p className="mt-1 text-sm text-text break-words">{formatNamespaces(selectedBackup.include_namespaces, 'All namespaces')}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-text-secondary">Exclude</p>
                  <p className="mt-1 text-sm text-text break-words">{formatNamespaces(selectedBackup.exclude_namespaces, 'None')}</p>
                </div>
              </div>

              <div className="rounded-lg border border-border p-4 bg-surface-elevated">
                <p className="text-xs uppercase tracking-wide text-text-secondary">Resource Summary</p>
                <p className="mt-1 text-sm text-text break-words">{selectedBackup.resource_summary || '-'}</p>
              </div>

              <div className="rounded-lg border border-border p-4 bg-surface-elevated">
                <p className="text-xs uppercase tracking-wide text-text-secondary">Kind Summary</p>
                {selectedBackup.kind_summary && Object.keys(selectedBackup.kind_summary).length > 0 ? (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {Object.entries(selectedBackup.kind_summary)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([kind, count]) => (
                        <div key={kind} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                          <span className="text-sm text-text-secondary">{formatKindLabel(kind)}</span>
                          <span className="text-sm font-medium text-text">{count}</span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-text">-</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmRestore !== null}
        title={`Restore from "${confirmRestore?.name ?? ''}"`}
        description={`This will create a new Velero Restore from backup "${confirmRestore?.name}". Existing resources may be overwritten. Continue?`}
        confirmLabel="Restore"
        destructive={false}
        isLoading={false}
        onConfirm={handleConfirmRestore}
        onCancel={() => setConfirmRestore(null)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={confirmDelete?.keys.length === 1
          ? `Are you sure you want to delete "${confirmDelete?.label}" from list and S3? This action cannot be undone.`
          : `Are you sure you want to delete ${confirmDelete?.keys.length} backups from list and S3? This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!isDeleting) setConfirmDelete(null);
        }}
      />
    </div>
  );
};
