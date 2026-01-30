const tabs = ['teams', 'bracket', 'rules'];

const tabTitle = {
  teams: 'Teams',
  bracket: 'Bracket',
  rules: 'Rules',
};

function qs(sel, root = document) {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function safeTab(input) {
  if (!input) return 'teams';
  const s = input.replace(/^#/, '').trim().toLowerCase();
  return (s === 'teams' || s === 'bracket' || s === 'rules') ? s : 'teams';
}

function setHash(tab) {
  if (location.hash.replace('#', '') !== tab) location.hash = tab;
}

function renderTeams() {
  const teamNames = Array.from({ length: 8 }, (_, i) => `Team ${i + 1}`);
  return `
    <header class="pageHeader">
      <div>
        <h1 class="h1">Teams</h1>
        <p class="subtle">Placeholders — swap these with your real roster.</p>
      </div>
      <div class="hint" aria-hidden="true">
        <span class="kbd">←</span><span class="kbd">→</span> switch tabs
      </div>
    </header>

    <section class="grid" aria-label="Teams list">
      ${teamNames.map((name, i) => {
        const seed = i + 1;
        const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2);
        return `
          <article class="card teamCard">
            <div class="teamTop">
              <div class="avatar" aria-hidden="true">${initials}</div>
              <div class="teamMeta">
                <div class="teamName">${name}</div>
                <div class="teamSubtle">Seed <span class="mono">#${seed}</span> • Record <span class="mono">0–0</span></div>
              </div>
            </div>
            <div class="teamStats" aria-hidden="true">
              <div class="stat">
                <div class="statLabel">Points</div>
                <div class="statValue mono">—</div>
              </div>
              <div class="stat">
                <div class="statLabel">Rank</div>
                <div class="statValue mono">—</div>
              </div>
              <div class="stat">
                <div class="statLabel">Notes</div>
                <div class="statValue mono">—</div>
              </div>
            </div>
          </article>
        `;
      }).join('')}
    </section>
  `;
}

function renderBracket() {
  const teams = Array.from({ length: 8 }, (_, i) => `Team ${i + 1}`);

  const round1 = [
    { a: teams[0], b: teams[7], time: 'TBD' },
    { a: teams[3], b: teams[4], time: 'TBD' },
    { a: teams[1], b: teams[6], time: 'TBD' },
    { a: teams[2], b: teams[5], time: 'TBD' },
  ];

  const round2 = [
    { a: 'Winner M1', b: 'Winner M2', time: 'TBD' },
    { a: 'Winner M3', b: 'Winner M4', time: 'TBD' },
  ];

  const final = [{ a: 'Winner SF1', b: 'Winner SF2', time: 'TBD' }];

  const rounds = [
    { title: 'Quarterfinals', matches: round1 },
    { title: 'Semifinals', matches: round2 },
    { title: 'Final', matches: final },
  ];

  return `
    <header class="pageHeader">
      <div>
        <h1 class="h1">Bracket</h1>
        <p class="subtle">Responsive bracket layout — scroll on mobile, full view on desktop.</p>
      </div>
      <div class="pill mono" aria-hidden="true">8 teams</div>
    </header>

    <section class="bracket" aria-label="Tournament bracket">
      ${rounds.map((r, ri) => `
        <div class="round" data-round="${ri + 1}">
          <div class="roundTitle">${r.title}</div>
          <div class="roundMatches">
            ${r.matches.map((m, mi) => `
              <article class="matchCard">
                <div class="matchMeta">
                  <span class="matchLabel mono">M${ri === 0 ? mi + 1 : (ri === 1 ? `SF${mi + 1}` : 'F')}</span>
                  <span class="matchTime mono">${m.time}</span>
                </div>
                <div class="teamRow">
                  <span class="teamTag">${m.a}</span>
                  <span class="score mono">—</span>
                </div>
                <div class="teamRow">
                  <span class="teamTag">${m.b}</span>
                  <span class="score mono">—</span>
                </div>
              </article>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </section>

    <p class="footnote subtle">Tip: on phones, swipe the bracket horizontally.</p>
  `;
}

function renderRules() {
  const rules = [
    {
      title: 'Format',
      items: [
        'Single elimination bracket.',
        'Seeding is placeholder (#1–#8).',
        'All times are TBD until scheduled.',
      ],
    },
    {
      title: 'Scoring',
      items: [
        'Use your game’s standard scoring.',
        'Ties go to a quick tiebreaker round (or sudden death).',
        'Report results immediately after each match.',
      ],
    },
    {
      title: 'Conduct',
      items: [
        'Be respectful and keep it friendly.',
        'No cheating or outside help.',
        'Organizer decisions are final.',
      ],
    },
  ];

  return `
    <header class="pageHeader">
      <div>
        <h1 class="h1">Rules</h1>
        <p class="subtle">Clean, readable rules layout — easy to scan on mobile.</p>
      </div>
      <div class="pill mono" aria-hidden="true">v1.0</div>
    </header>

    <section class="rulesGrid" aria-label="Rules">
      ${rules.map((r) => `
        <article class="card ruleCard">
          <h2 class="h2">${r.title}</h2>
          <ul class="ruleList">
            ${r.items.map((it) => `<li>${it}</li>`).join('')}
          </ul>
        </article>
      `).join('')}
    </section>

    <section class="card callout">
      <div class="calloutIcon" aria-hidden="true">!</div>
      <div>
        <div class="calloutTitle">Placeholder content</div>
        <div class="subtle">Replace these rules with your tournament’s official rules.</div>
      </div>
    </section>
  `;
}

function render(tab) {
  const content = qs('#content');
  const page = qs('#page');

  document.title = `${tabTitle[tab]} • Tournament`;

  page.innerHTML = tab === 'teams' ? renderTeams()
    : tab === 'bracket' ? renderBracket()
    : renderRules();

  const tabButtons = qsa('.tab');
  tabButtons.forEach((btn) => {
    const t = btn.dataset.tab;
    const isActive = t === tab;
    btn.classList.toggle('isActive', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.tabIndex = isActive ? 0 : -1;
  });

  const activeBtn = qs('.tab.isActive');
  const highlight = qs('.tabHighlight');
  const tabsWrap = qs('.tabsInner');

  const wrapRect = tabsWrap.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  const left = btnRect.left - wrapRect.left;
  highlight.style.transform = `translateX(${left}px)`;
  highlight.style.width = `${btnRect.width}px`;

  content.setAttribute('aria-label', `${tabTitle[tab]} page`);
}

function init() {
  const nav = qs('.tabsInner');
  nav.setAttribute('role', 'tablist');

  qsa('.tab').forEach((btn) => {
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
  });

  qs('#content');

  function applyFromHash() {
    const tab = safeTab(location.hash);
    render(tab);
  }

  qsa('.tab').forEach((btn) => {
    btn.addEventListener('click', () => setHash(btn.dataset.tab));
  });

  window.addEventListener('hashchange', applyFromHash);

  window.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;

    const current = safeTab(location.hash);
    const idx = tabs.indexOf(current);

    let next = current;
    if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
    if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (e.key === 'Home') next = tabs[0];
    if (e.key === 'End') next = tabs[tabs.length - 1];

    setHash(next);
  });

  window.addEventListener('resize', () => render(safeTab(location.hash)));

  if (!location.hash) location.hash = 'teams';
  applyFromHash();
}

init();
