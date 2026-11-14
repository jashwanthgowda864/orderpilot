import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, homeFor } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import CustomerHome from './pages/CustomerHome.jsx';
import OrderPage from './pages/OrderPage.jsx';
import Account from './pages/Account.jsx';
import InvoicePage from './pages/InvoicePage.jsx';
import StaffHome from './pages/StaffHome.jsx';
import Counter from './pages/Counter.jsx';
import PickList from './pages/PickList.jsx';
import PickOrder from './pages/PickOrder.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import Products from './pages/Products.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Insights from './pages/Insights.jsx';
import SupplierBills from './pages/SupplierBills.jsx';

function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

const ALL = ['customer', 'staff', 'owner'];
const STAFF = ['staff', 'owner'];

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={homeFor(user.role)} replace /> : <Login />} />
      <Route element={<RequireRole roles={ALL}><Layout /></RequireRole>}>
        <Route index element={<RequireRole roles={['customer']}><CustomerHome /></RequireRole>} />
        <Route path="account" element={<RequireRole roles={['customer']}><Account /></RequireRole>} />
        <Route path="orders/:id" element={<OrderPage />} />
        <Route path="invoices/:id" element={<InvoicePage />} />
        <Route path="staff" element={<RequireRole roles={STAFF}><StaffHome /></RequireRole>} />
        <Route path="counter" element={<RequireRole roles={STAFF}><Counter /></RequireRole>} />
        <Route path="pick" element={<RequireRole roles={STAFF}><PickList /></RequireRole>} />
        <Route path="pick/:id" element={<RequireRole roles={STAFF}><PickOrder /></RequireRole>} />
        <Route path="customers" element={<RequireRole roles={STAFF}><Customers /></RequireRole>} />
        <Route path="customers/:id" element={<RequireRole roles={STAFF}><CustomerDetail /></RequireRole>} />
        <Route path="owner" element={<RequireRole roles={['owner']}><Dashboard /></RequireRole>} />
        <Route path="products" element={<RequireRole roles={['owner']}><Products /></RequireRole>} />
        <Route path="supplier-bills" element={<RequireRole roles={['owner']}><SupplierBills /></RequireRole>} />
        <Route path="insights" element={<RequireRole roles={['owner']}><Insights /></RequireRole>} />
      </Route>
      <Route path="*" element={<Navigate to={user ? homeFor(user.role) : '/login'} replace />} />
    </Routes>
  );
}
