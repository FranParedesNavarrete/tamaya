import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, NavLink } from 'react-router-dom';
import { LayoutDashboard, ListTodo, Radio, Settings as SettingsIcon, X } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { JobsList } from './pages/JobsList';
import { NewJob } from './pages/NewJob';
import { ChannelsList } from './pages/ChannelsList';
import { ChannelForm } from './pages/ChannelForm';
import { Settings } from './pages/Settings';
import { ThemeToggle } from './components/theme-toggle';
import { isEmbed } from './lib/use-embed';

function NavItem({ to, icon, children }: { to: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <NavLink to={to} end
             className={({ isActive }) =>
               `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                 isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
               }`}>
      {icon}
      {children}
    </NavLink>
  );
}

/** Aviso global cuando la API devuelve 401 (token ausente o inválido). */
function UnauthorizedBanner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener('tamaya:unauthorized', handler);
    return () => window.removeEventListener('tamaya:unauthorized', handler);
  }, []);
  if (!visible) return null;
  return (
    <div className="bg-destructive text-destructive-foreground px-6 py-2 text-sm flex items-center justify-between">
      <span>
        API token no configurado o inválido.{' '}
        <Link to="/settings" className="underline font-medium" onClick={() => setVisible(false)}>
          Ve a Ajustes
        </Link>.
      </span>
      <button onClick={() => setVisible(false)} aria-label="Cerrar aviso" className="p-1 hover:opacity-80">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function App() {
  // Modo embed (?embed=1): oculta navbar y controles globales para incrustar.
  const embed = isEmbed();
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background" data-embed={embed ? '1' : undefined}>
        {!embed && (
          <nav className="bg-card border-b px-6 py-3 flex justify-between items-center sticky top-0 z-10">
            <Link to="/" className="flex items-center gap-2 font-bold text-xl tracking-tight">
              <img src="/favicon.png" alt="" aria-hidden="true" className="h-7 w-7 rounded-md" />
              <span>Tamaya</span>
            </Link>
            <div className="flex gap-1">
              <NavItem to="/" icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</NavItem>
              <NavItem to="/jobs" icon={<ListTodo className="h-4 w-4" />}>Jobs</NavItem>
              <NavItem to="/channels" icon={<Radio className="h-4 w-4" />}>Canales</NavItem>
              <NavItem to="/settings" icon={<SettingsIcon className="h-4 w-4" />}>Ajustes</NavItem>
            </div>
          </nav>
        )}
        {/* El aviso de 401 es un error crítico → se muestra también en embed. */}
        <UnauthorizedBanner />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/jobs" element={<JobsList />} />
          <Route path="/jobs/new" element={<NewJob />} />
          <Route path="/channels" element={<ChannelsList />} />
          <Route path="/channels/new" element={<ChannelForm />} />
          <Route path="/channels/:id/edit" element={<ChannelForm />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        {!embed && <ThemeToggle />}
      </div>
    </BrowserRouter>
  );
}
