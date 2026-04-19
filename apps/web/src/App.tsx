import { BrowserRouter, Routes, Route, Link, NavLink } from 'react-router-dom';
import { LayoutDashboard, ListTodo, Radio } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { JobsList } from './pages/JobsList';
import { NewJob } from './pages/NewJob';
import { ChannelsList } from './pages/ChannelsList';
import { ChannelForm } from './pages/ChannelForm';
import { ThemeToggle } from './components/theme-toggle';

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

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background">
        <nav className="bg-card border-b px-6 py-3 flex justify-between items-center sticky top-0 z-10">
          <Link to="/" className="font-bold text-xl tracking-tight">Tamaya</Link>
          <div className="flex gap-1">
            <NavItem to="/" icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</NavItem>
            <NavItem to="/jobs" icon={<ListTodo className="h-4 w-4" />}>Jobs</NavItem>
            <NavItem to="/channels" icon={<Radio className="h-4 w-4" />}>Canales</NavItem>
          </div>
        </nav>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/jobs" element={<JobsList />} />
          <Route path="/jobs/new" element={<NewJob />} />
          <Route path="/channels" element={<ChannelsList />} />
          <Route path="/channels/new" element={<ChannelForm />} />
          <Route path="/channels/:id/edit" element={<ChannelForm />} />
        </Routes>
        <ThemeToggle />
      </div>
    </BrowserRouter>
  );
}
