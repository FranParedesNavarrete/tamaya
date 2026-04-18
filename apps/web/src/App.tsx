import { BrowserRouter, Routes, Route, Link, NavLink } from 'react-router-dom';
import { JobsList } from './pages/JobsList';
import { NewJob } from './pages/NewJob';
import { ChannelsList } from './pages/ChannelsList';
import { ChannelForm } from './pages/ChannelForm';

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink to={to} end
             className={({ isActive }) =>
               `px-3 py-1 rounded-md text-sm ${
                 isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
               }`}>
      {children}
    </NavLink>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background">
        <nav className="bg-card border-b px-6 py-3 flex justify-between items-center">
          <Link to="/" className="font-bold text-xl">Tamaya</Link>
          <div className="flex gap-2">
            <NavItem to="/">Jobs</NavItem>
            <NavItem to="/channels">Canales</NavItem>
          </div>
        </nav>
        <Routes>
          <Route path="/" element={<JobsList />} />
          <Route path="/jobs/new" element={<NewJob />} />
          <Route path="/channels" element={<ChannelsList />} />
          <Route path="/channels/new" element={<ChannelForm />} />
          <Route path="/channels/:id/edit" element={<ChannelForm />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
