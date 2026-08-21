function text(parent, tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function badge(value, className = '') {
  const node = document.createElement('span');
  node.className = `badge ${className}`.trim();
  node.textContent = value;
  return node;
}

export function getAccountType(record) {
  if (record.isBusinessAccount) return 'business';
  if (record.isProfessionalAccount) return 'professional';
  return 'personal';
}

export function showToast(message) {
  const node = text(document.body, 'div', message, 'toast');
  setTimeout(() => node.remove(), 2800);
}

export function createProspectCard(record, chosen, callbacks) {
  const card = document.createElement('article');
  card.className = `prospect-card ${chosen ? 'chosen' : ''}`;
  const header = document.createElement('div');
  header.className = 'card-header';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'checkbox';
  check.checked = chosen;
  check.setAttribute('aria-label', `Choose @${record.username}`);
  check.addEventListener('change', () => callbacks.onChoose(record.username, check.checked));
  header.append(check);

  text(header, 'div', (record.fullName || record.username || '?').slice(0, 1).toUpperCase(), 'avatar');
  const heading = document.createElement('div');
  heading.className = 'card-heading';
  text(heading, 'h2', record.fullName || `@${record.username}`);
  text(heading, 'span', `@${record.username}`, 'username');
  header.append(heading);
  text(header, 'div', String(record.score.finalScore), 'score');
  card.append(header);

  const badges = document.createElement('div');
  badges.className = 'badges';
  const priorityClass = record.score.priorityLabel === 'High Priority' ? 'high' : record.score.priorityLabel === 'Excluded' ? 'excluded' : '';
  badges.append(badge(record.score.priorityLabel, priorityClass));
  badges.append(badge(`${record.postCount} posts`));
  badges.append(badge(record.isPrivate ? 'Private' : 'Public'));
  badges.append(badge(getAccountType(record)));
  if (record.status !== 'new') badges.append(badge(record.status));
  card.append(badges);

  text(card, 'p', record.biography || 'No biography provided.', 'bio');
  const reasons = document.createElement('div');
  reasons.className = 'reason-list';
  const items = record.qualification.qualified ? record.score.reasons : record.qualification.failures;
  items.slice(0, 4).forEach(item => text(reasons, 'span', `• ${item}`));
  card.append(reasons);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const select = text(actions, 'button', record.status === 'selected' ? 'Selected' : 'Select', `button ${record.status === 'selected' ? '' : 'secondary'}`);
  select.addEventListener('click', () => callbacks.onStatus(record.username, record.status === 'selected' ? 'new' : 'selected'));
  const profile = text(actions, 'a', 'Open profile', 'button secondary');
  profile.href = record.profileUrl;
  profile.target = '_blank';
  profile.rel = 'noopener noreferrer';
  card.append(actions);
  return card;
}

export function renderHistory(container, history) {
  if (!history.length) {
    text(container, 'p', 'No activity has been recorded yet.', 'muted');
    return;
  }
  const fragment = document.createDocumentFragment();
  history.forEach(entry => {
    const row = document.createElement('article');
    row.className = 'history-row';
    text(row, 'strong', entry.message);
    text(row, 'time', new Date(entry.timestamp).toLocaleString());
    fragment.append(row);
  });
  container.replaceChildren(fragment);
}

export function sortRecords(records, mode) {
  const sorted = [...records];
  const comparators = {
    'score-desc': (a, b) => b.score.finalScore - a.score.finalScore,
    'score-asc': (a, b) => a.score.finalScore - b.score.finalScore,
    'name-asc': (a, b) => (a.fullName || a.username).localeCompare(b.fullName || b.username),
    newest: (a, b) => b.firstSeenAt - a.firstSeenAt,
    oldest: (a, b) => a.firstSeenAt - b.firstSeenAt,
  };
  return sorted.sort(comparators[mode] ?? comparators['score-desc']);
}
