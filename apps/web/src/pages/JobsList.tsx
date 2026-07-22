import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type OpsPublisher } from '../api/client';
import type { Job } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import { AlertDialog, ConfirmDialog } from '../components/ui/alert-dialog';
import { format } from 'date-fns';
import {
  AlertTriangle, Activity, ArrowDown, ArrowUp, ArrowUpDown,
  RotateCcw, Trash2, XCircle, CopyPlus,
} from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-200 text-gray-800',
  resolving: 'bg-blue-100 text-blue-800',
  ready: 'bg-indigo-100 text-indigo-800',
  publishing: 'bg-yellow-100 text-yellow-800',
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-400 text-white',
};

const POST_SEND_PREFIX = 'POST_SEND_VERIFICATION_FAILED';

const VERIF_LABEL: Record<string, string> = {
  verified: 'verificado',
  verification_failed: 'no publicado',
  ambiguous_after_send: 'sin confirmar',
};
const VERIF_COLOR: Record<string, string> = {
  verified: 'bg-green-100 text-green-800',
  verification_failed: 'bg-red-100 text-red-800',
  ambiguous_after_send: 'bg-amber-100 text-amber-900',
};

const STATUS_TOOLTIPS: Record<string, string> = {
  pending: 'Esperando a la fecha programada / a que resolve lo procese.',
  resolving: 'Resolviendo/descargando la media.',
  ready: 'Resuelto y esperando a que worker-publish lo consuma.',
  publishing: 'Enviando en WhatsApp Web.',
  sent: 'Enviado correctamente.',
  failed: 'Falló la publicación. Revisa el error / debug dump.',
  cancelled: 'Cancelado por el usuario.',
};

interface ConfirmState {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
  onConfirm: () => void | Promise<void>;
}

type SortKey = 'createdAt' | 'channelName' | 'text' | 'media' | 'scheduledAt' | 'status' | 'lastError';
type SortDir = 'asc' | 'desc';

const SORT_LABEL: Record<SortKey, string> = {
  createdAt: 'Encolado',
  channelName: 'Canal',
  text: 'Texto',
  media: 'Media',
  scheduledAt: 'Programado',
  status: 'Estado',
  lastError: 'Error',
};

function SortableHead({
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted transition-colors"
        title={`Ordenar por ${SORT_LABEL[sortKey]}`}
      >
        <span>{SORT_LABEL[sortKey]}</span>
        <Icon className={`h-3.5 w-3.5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      </button>
    </TableHead>
  );
}

export function JobsList() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const statusFilter = params.get('status') ?? undefined;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [publisher, setPublisher] = useState<OpsPublisher | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  async function load() {
    setJobs(await api.listJobs(statusFilter ? { status: statusFilter } : undefined));
    setLoading(false);
    // Diagnóstico del publisher (no bloquea el listado si falla).
    try {
      setPublisher(await api.opsPublisher());
    } catch {
      setPublisher(null);
    }
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

  function onRequeue(job: Job) {
    setConfirmState({
      title: 'Reencolar publicación',
      description: 'Se volverá a encolar en publish-queue. Requiere que worker-publish esté activo para que se envíe. ¿Continuar?',
      confirmLabel: 'Reencolar',
      cancelLabel: 'Cancelar',
      variant: 'default',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await api.requeuePublish(job.id);
          await load();
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  const sortedJobs = useMemo(() => {
    const valueFor = (j: Job, key: SortKey): string | number => {
      if (key === 'media') return j.media.length;
      if (key === 'createdAt') return j.enqueueSeq || new Date(j.createdAt).getTime();
      if (key === 'scheduledAt') return new Date(j.scheduledAt).getTime();
      return (j[key] ?? '').toString().toLowerCase();
    };
    return [...jobs].sort((a, b) => {
      const av = valueFor(a, sortKey);
      const bv = valueFor(b, sortKey);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'es');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [jobs, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'createdAt' || key === 'scheduledAt' ? 'desc' : 'asc');
    }
  }

  const canCancel = (j: Job) => ['pending', 'ready', 'failed'].includes(j.status);
  const canDelete = (j: Job) => !['publishing', 'resolving'].includes(j.status);
  // Reintentar: disponible siempre que el job no esté en curso
  const canRetry = (j: Job) => !['publishing', 'resolving', 'pending', 'ready'].includes(j.status);
  // Reencolar publicación: solo para jobs resueltos o fallidos.
  const canRequeue = (j: Job) => ['ready', 'failed'].includes(j.status);

  // Banner: hay trabajo pendiente de publicar pero el publisher no está activo.
  const showPublisherWarning = Boolean(
    publisher && !publisher.publisherLikelyRunning &&
    (publisher.publishQueueWaiting > 0 || jobs.some((j) => j.status === 'ready')),
  );

  return (
    <div className="py-6 px-24">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/settings#diagnostico"><Activity className="h-4 w-4 mr-1" />Ver diagnóstico</Link>
          </Button>
          <Button asChild><Link to="/jobs/new">+ Nuevo</Link></Button>
        </div>
      </div>

      {showPublisherWarning && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              Hay jobs listos para publicar, pero worker-publish no está activo.
            </p>
            <p className="text-xs mt-1">
              En el servidor, arranca los procesos nativos una vez (sobreviven al boot):{' '}
              <code className="rounded bg-background px-1">npm run native:start</code>{' '}
              y luego <code className="rounded bg-background px-1">pm2 save</code>.
              {publisher?.publishQueueWaiting ? ` En cola: ${publisher.publishQueueWaiting}.` : ''}
            </p>
            <p className="text-[11px] mt-1 opacity-80">
              En desarrollo: <code className="rounded bg-background px-1">npm run dev -w apps/worker-publish</code>.
            </p>
          </div>
        </div>
      )}
      {loading ? <p>Cargando…</p> : jobs.length === 0 ? (
        <p className="text-muted-foreground">
          No hay jobs.{' '}
          <Link to="/jobs/new" className="underline">Crea el primero</Link>.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead sortKey="createdAt" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead sortKey="channelName" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead sortKey="text" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead sortKey="media" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead sortKey="scheduledAt" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead sortKey="status" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead sortKey="lastError" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedJobs.map((j) => (
              <TableRow key={j.id}>
                <TableCell>{format(new Date(j.createdAt), 'dd/MM HH:mm')}</TableCell>
                <TableCell>{j.channelName}</TableCell>
                <TableCell className="max-w-xs truncate">{j.text}</TableCell>
                <TableCell>{j.media.length}</TableCell>
                <TableCell>{format(new Date(j.scheduledAt), 'dd/MM HH:mm')}</TableCell>
                <TableCell>
                  <span
                    title={STATUS_TOOLTIPS[j.status] ?? j.status}
                    className={`px-2 py-1 rounded text-xs font-medium cursor-help ${STATUS_COLORS[j.status] ?? 'bg-gray-200'}`}>
                    {j.status}
                  </span>
                </TableCell>
                <TableCell className="max-w-xs text-xs">
                  {j.verificationMeta && (
                    <span
                      title={j.verificationMeta.reason ?? j.verificationMeta.result}
                      className={`inline-block mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${VERIF_COLOR[j.verificationMeta.result] ?? 'bg-gray-200'}`}>
                      verif: {VERIF_LABEL[j.verificationMeta.result] ?? j.verificationMeta.result}
                    </span>
                  )}
                  {j.lastError?.startsWith(POST_SEND_PREFIX) ? (
                    <div className="text-amber-700 dark:text-amber-400">
                      El worker no pudo verificar el contenido después de pulsar enviar. Puede
                      haberse publicado; no se reintentó para evitar duplicados. Revisa el canal.
                    </div>
                  ) : (
                    <div className="truncate text-destructive" title={j.lastError ?? undefined}>{j.lastError}</div>
                  )}
                  {j.debugDumpPath && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground truncate" title={j.debugDumpPath}>
                      Debug dump: {j.debugDumpPath}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {canRequeue(j) && (
                      <Button size="icon" variant="secondary" title="Reencolar" aria-label="Reencolar" onClick={() => onRequeue(j)}>
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                    {canRetry(j) && (
                      <Button size="icon" variant="secondary" title="Reintentar como nuevo" aria-label="Reintentar como nuevo"
                              onClick={() => nav(`/jobs/new?from=${j.id}`)}>
                        <CopyPlus className="h-4 w-4" />
                      </Button>
                    )}
                    {canCancel(j) && (
                      <Button size="icon" variant="outline" title="Cancelar" aria-label="Cancelar" onClick={() => onCancel(j)}>
                        <XCircle className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete(j) && (
                      <Button size="icon" variant="destructive" title="Borrar" aria-label="Borrar" onClick={() => onDelete(j)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
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
