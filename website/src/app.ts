type TabId = 'teams' | 'bracket' | 'rules';

const tabs: TabId[] = ['teams', 'bracket', 'rules'];

const tabTitle: Record<TabId, string> = {
  teams: 'Teams',
  bracket: 'Bracket',
  rules: 'Rules',
};

function qs<T extends Element>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el as T;
}

function safeTab(input: string | null | undefined): TabId {
  if (input === 'bracket' || input === 'rules' || input === 'teams') return input;
  return 'teams';
}

function renderTeams(): string {
  const teamNames = Array.from({ length: 8 }, (_, i) => `Team ${i + 1}`);

  return `
    <h1 class="h1">Teams</h1>
    <p class="subtle">Placeholder teams. Replace these with your real roster.</p>

    <section class="card">
      <ul class="list">
        ${teamNames.map((t) => `<li>${t}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderBracket(): string {
  // Simple 8-team bracket placeholder (Quarterfinals only)
  const matches = [
    ['Team 1', 'Team 2'],
    ['Team 3', 'Team 4'],
    ['Team 5', 'Team 6'],
    ['Team 7', 'Team 8'],
  ];

  return `
    <h1 class="h1">Bracket</h1>
    <p class="subtle">Placeholder bracket layout. Swap in your tournament logic later.</p>

    <section class="card">
      <div class="bracket">
        ${matches
          .map(
            ([a, b], idx) => `
            <div class="match" aria-label="Match ${idx + 1}">
              <div class="team"><span>${a}</span><span class="mono">0</span></div>
              <div class="team"><span>${b}</span><span class="mono">0</span></div>
            </div>
          `
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderRules(): string {
  return `
    <h1 class="h1">Rules</h1>
    <p class="subtle">Placeholder rules. Edit this section with your real tournament rules.</p>

    <section class="card">
      <ol class="list">
        <li>Rule 1: …</li>
        <li>Rule 2: …</li>
        <li>Rule 3: …</li>
      </ol>
      <p class="subtle" style="margin-top:12px;">Tip: you can link directly to a tab using <span class="kbd">#teams</span>, <span class="kbd">#bracket</span>, or <span class="kbd">#rules</span>.</p>
    </section>
  `;
}

function render(tab: TabId): void {
  // Update selected state
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
  for (const btn of tabButtons) {
    const isSelected = btn.dataset.tab === tab;
    btn.setAttribute('aria-selected', String(isSelected));
  }

  const content = qs<HTMLElement>('#content');

  switch (tab) {
    case 'teams':
      content.innerHTML = renderTeams();
      break;
    case 'bracket':
      content.innerHTML = renderBracket();
      break;
    case 'rules':
      content.innerHTML = renderRules();
      break;
    default: {
      const _exhaustive: never = tab;
      void _exhaustive;
    }
  }

  document.title = `${tabTitle[tab]}`;
}

function onTabClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  const btn = target?.closest<HTMLButtonElement>('button.tab');
  if (!btn) return;
  const tab = safeTab(btn.dataset.tab);
  location.hash = tab;
}

function init(): void {
  // Set ARIA attributes for accessibility
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
  for (const btn of tabButtons) {
    btn.setAttribute('role', 'tab');
  }
  const nav = qs<HTMLElement>('.tabs');
  nav.setAttribute('role', 'tablist');

  nav.addEventListener('click', onTabClick);

  const initial = safeTab(location.hash.replace('#', ''));
  render(initial);

  window.addEventListener('hashchange', () => {
    const next = safeTab(location.hash.replace('#', ''));
    render(next);
  });

  // Keyboard support: left/right arrows to switch tabs
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

    const current = safeTab(location.hash.replace('#', ''));
    const idx = tabs.indexOf(current);
    const nextIdx = e.key === 'ArrowRight'
      ? (idx + 1) % tabs.length
      : (idx - 1 + tabs.length) % tabs.length;

    location.hash = tabs[nextIdx];
  });
}

init();
