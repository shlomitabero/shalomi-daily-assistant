import { useEffect, useState } from 'react';
import { api } from './api';
import BottomNav from './components/BottomNav';
import Celebration from './components/Celebration';
import Tutorial from './components/Tutorial';
import Onboarding from './screens/Onboarding';
import Home from './screens/Home';
import Opportunities from './screens/Opportunities';
import Empire from './screens/Empire';
import BusinessDetail from './screens/BusinessDetail';
import Deals from './screens/Deals';
import Negotiation from './screens/Negotiation';
import RealEstate from './screens/RealEstate';
import Loans from './screens/Loans';
import Invest from './screens/Invest';
import World from './screens/World';
import Profile from './screens/Profile';
import Ranks from './screens/Ranks';
import Legacy from './screens/Legacy';

const NAV_SCREENS = new Set(['home', 'empire', 'deals', 'estate', 'loans', 'invest', 'world', 'profile']);

export default function App() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState({ name: 'home', params: {} });
  const [advancing, setAdvancing] = useState(false);
  const [celebrationQueue, setCelebrationQueue] = useState([]);
  const [showTutorial, setShowTutorial] = useState(false);

  useEffect(() => {
    const id = localStorage.getItem('fz_profile_id');
    if (!id) { setLoading(false); return; }
    api.getPlayer(id).then(setState).catch(() => localStorage.removeItem('fz_profile_id')).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (state && !localStorage.getItem('fz_tutorial_seen')) setShowTutorial(true);
  }, [state]);

  const dismissTutorial = () => {
    localStorage.setItem('fz_tutorial_seen', '1');
    setShowTutorial(false);
  };

  const nav = (name, params = {}) => setView({ name, params });

  const refresh = async () => {
    if (!state) return;
    const fresh = await api.getPlayer(state.profile.id);
    setState(fresh);
    return fresh;
  };

  const queueCelebration = (c) => setCelebrationQueue((q) => [...q, c]);

  const afterAction = async (result) => {
    if (result?.bankrupt) queueCelebration({ type: 'bankrupt' });
    if (result?.million) {
      queueCelebration({
        type: 'million',
        label: result.million.label,
        amount: result.netWorth ?? state.profile.netWorth,
        daysToReach: result.million.daysToReach,
        firstBusiness: result.million.firstBusiness,
        businessCount: result.million.businessCount,
      });
    }
    if (result?.rankedUp && result?.rank) {
      queueCelebration({
        type: 'rankup',
        title: result.rank.title,
        unlock: result.rank.unlock,
        major: result.rank.rank % 10 === 0,
        rank: result.rank.rank,
      });
    }
    await refresh();
  };

  const handleCreated = (newState) => { setState(newState); nav('home'); };

  const handleAdvanceDay = async () => {
    setAdvancing(true);
    try {
      const result = await api.advanceDay(state.profile.id);
      await afterAction(result);
    } finally {
      setAdvancing(false);
    }
  };

  if (loading) {
    return <div className="app-frame center"><div className="spinner" /></div>;
  }

  if (!state) {
    return (
      <div className="app-frame">
        <Onboarding onCreated={handleCreated} />
      </div>
    );
  }

  const showNav = NAV_SCREENS.has(view.name);

  return (
    <div className="app-frame">
      {view.name !== 'negotiation' && (
        <div className="topbar row-between">
          <div className="brand">FROM ZERO<span className="dot">.</span></div>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge accent">Rank {state.rank.rank}</span>
            <span className="badge money">{formatShort(state.profile.netWorth)}</span>
            <button className="btn btn-sm btn-ghost" style={{ borderRadius: 999, width: 26, height: 26, padding: 0 }} onClick={() => setShowTutorial(true)}>?</button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {view.name === 'home' && (
          <Home state={state} onNavigate={nav} onAdvanceDay={handleAdvanceDay} advancing={advancing} />
        )}
        {view.name === 'opportunities' && (
          <Opportunities state={state} onBack={() => nav('home')}
            onBought={async (result, opportunity) => {
              queueCelebration({ type: 'purchase', businessName: result.business.name, valuation: opportunity?.cost ?? 0 });
              await afterAction(result);
              nav('business', { bizId: result.business.id });
            }} />
        )}
        {view.name === 'empire' && (
          <Empire state={state} onNavigate={nav} onOpenBusiness={(bizId) => nav('business', { bizId })} onChanged={refresh} />
        )}
        {view.name === 'business' && (
          <BusinessDetail profileId={state.profile.id} bizId={view.params.bizId} rank={state.rank.rank}
            onBack={() => nav('empire')} onChanged={refresh} onOpenBusiness={(bizId) => nav('business', { bizId })} />
        )}
        {view.name === 'deals' && (
          <Deals state={state} onBack={() => nav('home')}
            onOpenNegotiation={(offerId) => nav('negotiation', { offerId })} />
        )}
        {view.name === 'negotiation' && (
          <Negotiation profileId={state.profile.id} offerId={view.params.offerId}
            onBack={() => nav('deals')}
            onClosed={async (result, context) => {
              if (result) {
                queueCelebration({
                  type: 'dealclosed',
                  companyName: context?.target?.name ?? result.business?.name,
                  price: context?.price ?? 0,
                  stakePct: context?.stakePct ?? result.business?.ownership_pct,
                });
                await afterAction(result);
              } else {
                await refresh();
              }
              nav('empire');
            }} />
        )}
        {view.name === 'estate' && <RealEstate state={state} onChanged={refresh} />}
        {view.name === 'loans' && <Loans state={state} onChanged={refresh} />}
        {view.name === 'invest' && <Invest state={state} onChanged={refresh} />}
        {view.name === 'world' && <World state={state} onNavigate={nav} />}
        {view.name === 'profile' && <Profile state={state} onNavigate={nav} />}
        {view.name === 'ranks' && <Ranks state={state} onBack={() => nav('profile')} />}
        {view.name === 'legacy' && <Legacy state={state} onBack={() => nav('profile')} />}
      </div>

      {showNav && (
        <BottomNav
          active={view.name}
          onNavigate={(key) => nav(key)}
        />
      )}

      <Celebration celebration={celebrationQueue[0] ?? null} onDismiss={() => setCelebrationQueue((q) => q.slice(1))} avatar={state.profile.avatar} />
      {showTutorial && <Tutorial onDone={dismissTutorial} />}
    </div>
  );
}

function formatShort(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n}`;
}
