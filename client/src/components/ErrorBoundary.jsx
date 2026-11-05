import { Component } from 'react';
import { api, getToken } from '../api.js';

// Without this, a render-time error anywhere in the app (a bad field from
// the API, a null the UI didn't expect) turns into a blank white screen
// with no way back except manually editing the URL and hoping that page
// doesn't crash too. This catches it, shows the owner something readable,
// and offers a reload instead of leaving them stuck looking at nothing.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error', error, info);
    // Until now this was only ever visible in the browser's own console -
    // the owner would never see it unless they happened to have devtools
    // open at the exact moment it happened. Best-effort only (never let a
    // failed report cause a second crash), and only when logged in - this
    // boundary also wraps the public, unauthenticated product page, where
    // there is no owner token to report under at all.
    if (getToken()) {
      api.reportClientError(String(error?.message ?? error), window.location.pathname).catch(() => {});
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', direction: 'rtl' }}>
          <h2>משהו נתקע</h2>
          <p>קרתה תקלה בלתי צפויה בעמוד הזה. הנתונים שלך לא נפגעו.</p>
          <button onClick={() => { this.setState({ error: null }); window.location.href = '/'; }}>
            חזרה לדשבורד
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
