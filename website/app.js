import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const tabs = ['teams', 'bracket', 'rules'];
const tabTitle = { teams: 'Teams', bracket: 'Bracket', rules: 'Rules' };

function qs(sel, root = document) {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function isMobile() { return window.matchMedia('(max-width: 720px)').matches; }

function defaultTeams() {
  return Array.from({ length: 8 }, (_, i) => {
    const teamNo = i + 1;
    const base = i * 4;
    return { name: `Team ${teamNo}`, players: [`Player ${base + 1}`, `Player ${base + 2}`, `Player ${base + 3}`, `Player ${base + 4}`] };
  });
}
function normalizeTeams(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') return null;
    const name = typeof t.name === 'string' ? t.name : '';
    const players = Array.isArray(t.players) ? t.players : [];
    if (!name || players.length !== 4) return null;
    const clean = players.map((p) => (typeof p === 'string' && p.trim() ? p.trim() : 'Player')).slice(0, 4);
    out.push({ name, players: clean });
  }
  if (out.length !== 8) return null;
  return out;
}

function readConfig() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg) return null;
  if (!cfg.apiKey || !cfg.projectId) return null;
  return cfg;
}

function initFirebase() {
  const cfg = readConfig();
  if (!cfg) return null;
  const app = initializeApp(cfg);
  const db = getFirestore(app);
  const auth = getAuth(app);

  try {
    onAuthStateChanged(auth, (u) => { if (!u) signInAnonymously(auth).catch(() => {}); });
  } catch { /* ignore */ }

  return { app, db, auth };
}

function subscribeTeams(db, onData, onError) {
  const ref = doc(db, 'tournaments', 'default');
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) return onData(null);
    onData((snap.data() || {}).teams ?? null);
  }, onError);
}

async function ensureDefaultTeams(db, teams) {
  const ref = doc(db, 'tournaments', 'default');
  await setDoc(ref, { teams, updatedAt: serverTimestamp() }, { merge: true });
}
async function writeTeams(db, teams) {
  const ref = doc(db, 'tournaments', 'default');
  await setDoc(ref, { teams, updatedAt: serverTimestamp() }, { merge: true });
}

/* ---------------- State ---------------- */
let activeTab = 'teams';
let teamsState = defaultTeams();

let mobileTeamIndex = 0;
let mobileRoundIndex = 0;

let firebaseError = null;

const fb = initFirebase();
const hasFirebase = !!fb;

let unsubscribe = null;
let writeTimer = null;
let pendingWrite = false;

function scheduleWrite() {
  if (!fb) return;
  pendingWrite = true;
  if (writeTimer) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(async () => {
    writeTimer = null;
    if (!pendingWrite) return;
    pendingWrite = false;
    try { await writeTeams(fb.db, teamsState); }
    catch (e) {
      firebaseError = 'Could not save to Firebase. Check your Firestore rules and config.';
      console.error(e);
    }
    render();
  }, 400);
}

async function bootFirebase() {
  if (!fb) return;
  try {
    unsubscribe = subscribeTeams(
      fb.db,
      async (raw) => {
        const normalized = normalizeTeams(raw);
        if (!normalized) await ensureDefaultTeams(fb.db, teamsState);
        else teamsState = normalized;
        render();
      },
      (err) => {
        console.error(err);
        firebaseError = 'Live sync error. Check your network and Firestore rules.';
        render();
      }
    );
  } catch (e) {
    console.error(e);
    firebaseError = 'Firebase init failed. Check your config.js and project settings.';
    render();
  }
}

/* ---------------- Rendering ---------------- */
function renderTopbar() {
  const nav = qs('#tabs');
  nav.innerHTML = tabs.map((id) => {
    const active = id === activeTab ? 'true' : 'false';
    return `<button class="tabBtn" data-tab="${id}" aria-selected="${active}" role="tab">${tabTitle[id]}</button>`;
  }).join('');

  const indicator = qs('#tabIndicator');
  const activeBtn = nav.querySelector(`button[data-tab="${activeTab}"]`);
  if (activeBtn) {
    const navRect = nav.getBoundingClientRect();
    const r = activeBtn.getBoundingClientRect();
    indicator.style.setProperty('--x', `${r.left - navRect.left}px`);
    indicator.style.setProperty('--w', `${r.width}px`);
  }

  const status = document.querySelector('#cloudStatus');
  if (!status) return;
  if (!hasFirebase) status.innerHTML = `<span class="pill warn">Not connected</span>`;
  else if (firebaseError) status.innerHTML = `<span class="pill warn">Sync issue</span>`;
  else status.innerHTML = `<span class="pill ok">Live</span>`;
}

function renderPage() {
  if (!hasFirebase) return renderSetup();
  if (firebaseError) return renderSetup(firebaseError);

  if (activeTab === 'teams') return isMobile() ? renderTeamsMobile() : renderTeamsDesktop();
  if (activeTab === 'bracket') return isMobile() ? renderBracketMobile() : renderBracketDesktop();
  return renderRules();
}

function renderSetup(extra) {
  return `
    <section class="setup">
      <div class="setupCard">
        <h1 class="h1">Connect Firebase</h1>
        <p class="subtle">
          This app syncs team/player names via Firebase (not local storage).
          Add your Firebase Web config in <span class="mono">website/config.js</span>.
        </p>

        <div class="setupGrid">
          <div class="setupStep">
            <div class="stepNo">1</div>
            <div>
              <div class="stepTitle">Create a Firebase project</div>
              <div class="stepBody">Enable Firestore Database. (Optional: enable Anonymous Auth.)</div>
            </div>
          </div>
          <div class="setupStep">
            <div class="stepNo">2</div>
            <div>
              <div class="stepTitle">Paste config</div>
              <div class="stepBody">Copy the web config into <span class="mono">config.js</span> (see <span class="mono">config.example.js</span>).</div>
            </div>
          </div>
          <div class="setupStep">
            <div class="stepNo">3</div>
            <div>
              <div class="stepTitle">Set Firestore rules</div>
              <div class="stepBody">Allow read/write to <span class="mono">tournaments/default</span> for your intended audience.</div>
            </div>
          </div>
        </div>

        ${extra ? `<div class="setupWarn">${escapeHtml(extra)}</div>` : ''}
        <div class="setupBtns">
          <button class="primaryBtn" id="reloadBtn">Reload</button>
          <a class="ghostBtn" href="./SETUP_FIREBASE.md" target="_blank" rel="noreferrer">Setup guide</a>
        </div>
      </div>
    </section>
  `;
}

function renderTeamsDesktop() {
  return `
    <header class="pageHeader tight">
      <div>
        <h1 class="h1">Teams</h1>
        <p class="subtle">Double-click a player name to edit. Changes sync live.</p>
      </div>
      <div class="hint" aria-hidden="true">
        <span class="kbd">←</span><span class="kbd">→</span> tabs
      </div>
    </header>

    <section class="teamsGrid" aria-label="Teams list">
      ${teamsState.map((t, i) => {
        const seed = i + 1;
        return `
          <article class="teamCard" data-team="${i}">
            <div class="teamHead">
              <div class="seed">#${seed}</div>
              <div class="teamName">${escapeHtml(t.name)}</div>
            </div>
            <ul class="players">
              ${t.players.map((p, pi) => `
                <li class="playerRow">
                  <span class="playerNo">${pi + 1}</span>
                  <span class="playerName editable" data-team="${i}" data-player="${pi}" tabindex="0">${escapeHtml(p)}</span>
                </li>
              `).join('')}
            </ul>
          </article>
        `;
      }).join('')}
    </section>
  `;
}

function renderTeamsMobile() {
  const i = clamp(mobileTeamIndex, 0, teamsState.length - 1);
  const t = teamsState[i];
  return `
    <header class="pageHeader tight">
      <div>
        <h1 class="h1">Teams</h1>
        <p class="subtle">Swipe to switch teams. Double-tap a name to edit.</p>
      </div>
      <div class="pager">
        <button class="iconBtn" id="prevTeam" aria-label="Previous team">‹</button>
        <div class="pagerLabel">${escapeHtml(t.name)}</div>
        <button class="iconBtn" id="nextTeam" aria-label="Next team">›</button>
      </div>
    </header>

    <section class="mobileStage" aria-label="Team editor">
      <article class="teamCard big" data-team="${i}" id="teamSwipe">
        <div class="teamHead">
          <div class="seed">#${i + 1}</div>
          <div class="teamName">${escapeHtml(t.name)}</div>
        </div>

        <ul class="players big">
          ${t.players.map((p, pi) => `
            <li class="playerRow">
              <span class="playerNo">${pi + 1}</span>
              <span class="playerName editable" data-team="${i}" data-player="${pi}" tabindex="0">${escapeHtml(p)}</span>
            </li>
          `).join('')}
        </ul>

        <div class="dots" aria-hidden="true">
          ${teamsState.map((_, di) => `<span class="dot${di === i ? ' on' : ''}"></span>`).join('')}
        </div>
      </article>
    </section>
  `;
}

function bracketRounds() {
  const t = teamsState.map((x) => x.name);
  const round1 = [
    { a: t[0], b: t[7], time: 'TBD' },
    { a: t[3], b: t[4], time: 'TBD' },
    { a: t[1], b: t[6], time: 'TBD' },
    { a: t[2], b: t[5], time: 'TBD' },
  ];
  const round2 = [
    { a: 'Winner QF1', b: 'Winner QF2', time: 'TBD' },
    { a: 'Winner QF3', b: 'Winner QF4', time: 'TBD' },
  ];
  const final = [{ a: 'Winner SF1', b: 'Winner SF2', time: 'TBD' }];
  return [
    { title: 'Quarterfinals', matches: round1 },
    { title: 'Semifinals', matches: round2 },
    { title: 'Final', matches: final },
  ];
}

function renderBracketDesktop() {
  const rounds = bracketRounds();
  return `
    <header class="pageHeader tight">
      <div>
        <h1 class="h1">Bracket</h1>
        <p class="subtle">Desktop view shows all rounds at once.</p>
      </div>
    </header>

    <section class="bracketGrid" aria-label="Bracket">
      ${rounds.map((r) => `
        <div class="round">
          <div class="roundTitle">${r.title}</div>
          <div class="matchList">
            ${r.matches.map((m) => `
              <div class="match">
                <div class="matchLine">
                  <span class="teamA">${escapeHtml(m.a)}</span>
                  <span class="vs">vs</span>
                  <span class="teamB">${escapeHtml(m.b)}</span>
                </div>
                <div class="matchTime">${escapeHtml(m.time)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </section>
  `;
}

function renderBracketMobile() {
  const rounds = bracketRounds();
  const ri = clamp(mobileRoundIndex, 0, rounds.length - 1);
  const r = rounds[ri];
  return `
    <header class="pageHeader tight">
      <div>
        <h1 class="h1">Bracket</h1>
        <p class="subtle">Tap to switch rounds. No scrolling.</p>
      </div>
      <div class="seg">
        ${rounds.map((x, i) => `<button class="segBtn ${i === ri ? 'on' : ''}" data-round="${i}">${x.title}</button>`).join('')}
      </div>
    </header>

    <section class="mobileStage" aria-label="Round">
      <div class="round">
        <div class="roundTitle big">${r.title}</div>
        <div class="matchList big">
          ${r.matches.map((m) => `
            <div class="match">
              <div class="matchLine">
                <span class="teamA">${escapeHtml(m.a)}</span>
                <span class="vs">vs</span>
                <span class="teamB">${escapeHtml(m.b)}</span>
              </div>
              <div class="matchTime">${escapeHtml(m.time)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderRules() {
  return `
    <header class="pageHeader tight">
      <div>
        <h1 class="h1">Rules</h1>
        <p class="subtle">Short rules card — edit this text later.</p>
      </div>
    </header>

    <section class="rulesGrid" aria-label="Rules">
      <article class="ruleCard">
        <h2 class="h2">Format</h2>
        <ul class="bullets">
          <li>8 teams, single elimination</li>
          <li>Best of 1 (adjust as needed)</li>
          <li>Seeding: 1–8</li>
        </ul>
      </article>

      <article class="ruleCard">
        <h2 class="h2">Match</h2>
        <ul class="bullets">
          <li>Start time: TBD</li>
          <li>Report scores to host</li>
          <li>Winner advances</li>
        </ul>
      </article>

      <article class="ruleCard">
        <h2 class="h2">Conduct</h2>
        <ul class="bullets">
          <li>Be chill</li>
          <li>No cheating</li>
          <li>Have fun</li>
        </ul>
      </article>
    </section>
  `;
}

/* ---------------- Interactions ---------------- */
function wireTabClicks() {
  qs('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const next = btn.dataset.tab;
    if (!tabs.includes(next)) return;
    activeTab = next;
    render();
  });
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const idx = tabs.indexOf(activeTab);
    const nextIdx = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
    const next = tabs[clamp(nextIdx, 0, tabs.length - 1)];
    if (next !== activeTab) { activeTab = next; render(); }
  });
}

function wireEditableNames(root) {
  root.querySelectorAll('.editable').forEach((el) => {
    el.addEventListener('dblclick', () => startInlineEdit(el));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') startInlineEdit(el); });
  });
}

function startInlineEdit(target) {
  const ti = Number(target.dataset.team ?? '');
  const pi = Number(target.dataset.player ?? '');
  if (!Number.isFinite(ti) || !Number.isFinite(pi)) return;

  const current = (teamsState?.[ti]?.players?.[pi]) ?? (target.textContent ?? '');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'playerEdit';
  input.value = current;
  input.setAttribute('aria-label', `Edit player ${pi + 1} for team ${ti + 1}`);

  const parent = target.parentElement;
  if (!parent) return;
  parent.replaceChild(input, target);
  input.focus();
  input.select();

  const restore = (value) => {
    const span = document.createElement('span');
    span.className = 'playerName editable';
    span.dataset.team = String(ti);
    span.dataset.player = String(pi);
    span.tabIndex = 0;
    span.textContent = value;
    parent.replaceChild(span, input);
    span.addEventListener('dblclick', () => startInlineEdit(span));
    span.addEventListener('keydown', (e) => { if (e.key === 'Enter') startInlineEdit(span); });
  };

  const commit = () => {
    const next = input.value.trim() || current;
    if (teamsState[ti] && teamsState[ti].players[pi] !== undefined) {
      teamsState[ti].players[pi] = next;
      scheduleWrite();
    }
    restore(next);
  };

  const cancel = () => restore(current);

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });
}

function wireMobilePagers(root) {
  const prevTeam = root.querySelector('#prevTeam');
  const nextTeam = root.querySelector('#nextTeam');
  if (prevTeam && nextTeam) {
    prevTeam.addEventListener('click', () => { mobileTeamIndex = (mobileTeamIndex - 1 + teamsState.length) % teamsState.length; render(); });
    nextTeam.addEventListener('click', () => { mobileTeamIndex = (mobileTeamIndex + 1) % teamsState.length; render(); });
    const swipe = root.querySelector('#teamSwipe');
    if (swipe) wireSwipe(swipe, () => nextTeam.click(), () => prevTeam.click());
  }

  root.querySelectorAll('button[data-round]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.round ?? '0');
      if (!Number.isFinite(i)) return;
      mobileRoundIndex = clamp(i, 0, 2);
      render();
    });
  });
}

function wireSwipe(el, onLeft, onRight) {
  let startX = 0, startY = 0, active = false;
  el.addEventListener('pointerdown', (e) => {
    active = true;
    startX = e.clientX;
    startY = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) onLeft();
    else onRight();
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/* ---------------- Mount ---------------- */
const page = qs('#page');
wireTabClicks();
wireKeyboard();

function render() {
  renderTopbar();
  page.innerHTML = renderPage();

  const reloadBtn = page.querySelector('#reloadBtn');
  if (reloadBtn) reloadBtn.addEventListener('click', () => window.location.reload());

  wireEditableNames(page);
  wireMobilePagers(page);

  window.requestAnimationFrame(renderTopbar);
}

window.addEventListener('resize', () => render());

render();
bootFirebase();
