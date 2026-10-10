import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Opportunities from './pages/Opportunities.jsx';
import OpportunityDetail from './pages/OpportunityDetail.jsx';
import Sources from './pages/Sources.jsx';
import Approvals from './pages/Approvals.jsx';
import Financial from './pages/Financial.jsx';
import ActivityLog from './pages/ActivityLog.jsx';
import Settings from './pages/Settings.jsx';
import Digests from './pages/Digests.jsx';
import ProductPage from './pages/ProductPage.jsx';
import Shell from './components/Shell.jsx';

function Protected({ children }) {
  const { authed } = useAuth();
  if (!authed) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/p/:slug" element={<ProductPage />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/opportunities" element={<Protected><Opportunities /></Protected>} />
      <Route path="/opportunities/:id" element={<Protected><OpportunityDetail /></Protected>} />
      <Route path="/sources" element={<Protected><Sources /></Protected>} />
      <Route path="/approvals" element={<Protected><Approvals /></Protected>} />
      <Route path="/financial" element={<Protected><Financial /></Protected>} />
      <Route path="/activity" element={<Protected><ActivityLog /></Protected>} />
      <Route path="/digests" element={<Protected><Digests /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
