import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

const NAV = {
  customer: [['/', 'Order'], ['/account', 'My account']],
  staff: [['/staff', 'Orders'], ['/counter', 'Counter'], ['/pick', 'Pick list'], ['/customers', 'Customers']],
  owner: [['/owner', 'Dashboard'], ['/staff', 'Orders'], ['/counter', 'Counter'], ['/pick', 'Pick list'], ['/customers', 'Customers'], ['/products', 'Products']],
};

export default function Layout() {
  const { user, shop, logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">OrderPilot<span className="muted small"> · {shop?.shop?.name || ''}</span></div>
        <nav>
          {NAV[user.role].map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>
          ))}
        </nav>
        <div className="who">
          <span className="small">{user.name} <span className="muted">({user.role})</span></span>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </header>
      {shop?.ai?.mock && (
        <div className="banner">Demo mode: no Gemini key set. Typed orders are parsed by a simple built-in matcher; photos and voice notes will ask you to type the items.</div>
      )}
      <main><Outlet /></main>
    </div>
  );
}
