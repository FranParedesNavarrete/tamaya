import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Job } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import { AlertDialog, ConfirmDialog } from '../components/ui/alert-dialog';
import { format } from 'date-fns';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-200 text-gray-800',
  resolving: 'bg-blue-100 text-blue-800',
  ready: 'bg-indigo-100 text-indigo-800',
  publishing: 'bg-yellow-100 text-yellow-800',
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-400 text-white',
};

interface ConfirmState {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
  onConfirm: () => void | Promise<void>;
}

export function JobsList() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const statusFilter = params.get('status') ?? undefined;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function load() {
    setJobs(await api.listJobs(statusFilter ? { status: statusFilter } : undefined));
    setLoading(false);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function onCancel(job: Job) {
    setConfirmState({
      title: 'Cancelar job',
      description: `¿Cancelar el job para "${job.channelName}"?`,
      confirmLabel: 'Cancelar job',
      cancelLabel: 'Volver',
      variant: 'default',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await api.cancelJob(job.id);
          await load();
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  function onDelete(job: Job) {
    setConfirmState({
      title: 'Borrar job',
      description: '¿Borrar definitivamente este job?',
      confirmLabel: 'Borrar',
      cancelLabel: 'Cancelar',
      variant: 'destructive',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await api.deleteJob(job.id);
          await load();
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  const canCancel = (j: Job) => ['pending', 'ready', 'failed'].includes(j.status);
  const canDelete = (j: Job) => !['publishing', 'resolving'].includes(j.status);
  // Reintentar: disponible siempre que el job no esté en curso
  const canRetry = (j: Job) => !['publishing', 'resolving', 'pending', 'ready'].includes(j.status);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <Button asChild><Link to="/jobs/new">+ Nuevo</Link></Button>
      </div>
      {loading ? <p>Cargando…</p> : jobs.length === 0 ? (
        <p className="text-muted-foreground">
          No hay jobs.{' '}
          <Link to="/jobs/new" className="underline">Crea el primero</Link>.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Canal</TableHead>
              <TableHead>Texto</TableHead>
              <TableHead>Media</TableHead>
              <TableHead>Programado</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Error</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id}>
                <TableCell>{j.channelName}</TableCell>
                <TableCell className="max-w-xs truncate">{j.text}</TableCell>
                <TableCell>{j.media.length}</TableCell>
                <TableCell>{format(new Date(j.scheduledAt), 'dd/MM HH:mm')}</TableCell>
                <TableCell>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${STATUS_COLORS[j.status] ?? 'bg-gray-200'}`}>
                    {j.status}
                  </span>
                </TableCell>
                <TableCell className="max-w-xs truncate text-destructive text-xs">
                  {j.lastError}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  {canRetry(j) && (
                    <Button size="sm" variant="secondary"
                            onClick={() => nav(`/jobs/new?from=${j.id}`)}>
                      Reintentar
                    </Button>
                  )}
                  {canCancel(j) && (
                    <Button size="sm" variant="outline" onClick={() => onCancel(j)}>
                      Cancelar
                    </Button>
                  )}
                  {canDelete(j) && (
                    <Button size="sm" variant="destructive" onClick={() => onDelete(j)}>
                      Borrar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title ?? ''}
        description={confirmState?.description}
        confirmLabel={confirmState?.confirmLabel}
        cancelLabel={confirmState?.cancelLabel}
        variant={confirmState?.variant}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
      <AlertDialog
        open={!!errorMsg}
        message={errorMsg}
        onClose={() => setErrorMsg(null)}
      />
    </div>
  );
}
