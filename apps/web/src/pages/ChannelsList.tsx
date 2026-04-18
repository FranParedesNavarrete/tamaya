import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Channel } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import { format } from 'date-fns';

export function ChannelsList() {
  const nav = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setChannels(await api.listChannels());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function onDelete(ch: Channel) {
    if (!confirm(`¿Borrar el canal "${ch.name}"?`)) return;
    try {
      await api.deleteChannel(ch.id);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
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
    </div>
  );
}
