import { createRoot } from 'react-dom/client';
import { BitPresence } from '../../src/BitPresence';
import '../../src/style.css';
const now = Date.now();
const approvals = Array.from({ length: 80 }, (_, i) => ({ id: String(i), action_summary: `Approval ${i + 1}: visible scrolling content`, risk: 'risky', requested_at: new Date(now).toISOString(), expires_at: new Date(now + 3600000).toISOString(), status: 'pending' }));
createRoot(document.getElementById('root')!).render(<>
 <header><div><span className="eyebrow">OZZY / OPERATING SYSTEM</span><h1>bIT OS <small>Dashboard</small></h1></div><div className="toolbar"><BitPresence approvals={approvals} now={now}/><label>Workspace<select><option>QA workspace</option></select></label><button>Refresh</button><button>Sign out</button></div></header>
 <main style={{ minHeight: 3000 }}><h2>Workspace overview</h2><p>Deterministic panel fixture. No account or network access required.</p><button>Outside control</button></main>
</>);
