import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Channel } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import { AlertDialog, ConfirmDialog } from '../components/ui/alert-dialog';
import { format } from 'date-fns';

interface ConfirmState {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
  onConfirm: () => void | Promise<void>;
}

export function ChannelsList() {
  const nav = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function load() {
    setChannels(await api.listChannels());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function onDelete(ch: Channel) {
    setConfirmState({
      title: 'Borrar canal',
      description: `¿Borrar el canal "${ch.name}"?`,
      confirmLabel: 'Borrar',
      cancelLabel: 'Cancelar',
      variant: 'destructive',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await api.deleteChannel(ch.id);
          await load();
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Canales</h1>
        <Button asChild><Link to="/channels/new">+ Nuevo canal</Link></Button>
      </div>
      {loading ? <p>Cargando…</p> : channels.length === 0 ? (
        <p className="text-muted-foreground">
          No hay canales aún. <Link to="/channels/new" className="underline">Crea el primero</Link>.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Acrónimo</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Creado</TableHead>
              <TableHead>Actualizado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono">{c.acronym ?? '—'}</TableCell>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="max-w-xs truncate">{c.description ?? '—'}</TableCell>
                <TableCell>{format(new Date(c.createdAt), 'dd/MM/yy HH:mm')}</TableCell>
                <TableCell>{format(new Date(c.updatedAt), 'dd/MM/yy HH:mm')}</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline"
                          onClick={() => nav(`/channels/${c.id}/edit`)}>
                    Editar
                  </Button>
                  <Button size="sm" variant="destructive"
                          onClick={() => onDelete(c)}>
                    Borrar
                  </Button>
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
