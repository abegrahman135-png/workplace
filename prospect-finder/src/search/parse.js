/**
 * parse.js — Shorthand query language for the command palette.
 *   ">500 followers"   "posts>50"   "private"   "@sourceuser"   "!married"
 */

const NUM_FIELDS = {
  followers: 'followers', follower: 'followers', f: 'followers',
  posts: 'posts', post: 'posts', p: 'posts',
  following: 'following',
  score: 'finalScore', female: 'femaleScore', ratio: 'ratio',
};

const FLAGS = {
  private:  { field: 'isPrivate', op: 'eq', value: true },
  public:   { field: 'isPrivate', op: 'eq', value: false },
  verified: { field: 'isVerified', op: 'eq', value: true },
  business: { field: 'isBusiness', op: 'eq', value: true },
  personal: { field: 'accountType', op: 'eq', value: 'Personal' },
  taken:    { field: 'isTaken', op: 'eq', value: true },
  single:   { field: 'isTaken', op: 'eq', value: false },
  story:    { field: 'hasStory', op: 'eq', value: true },
  boosted:  { field: 'manualPriority', op: 'eq', value: true },
  high:     { field: 'label', op: 'eq', value: 'high_priority' },
  qualified:{ field: 'label', op: 'eq', value: 'qualified' },
  review:   { field: 'label', op: 'eq', value: 'review' },
  failed:   { field: 'stage', op: 'in', value: ['failed', 'dead'] },
};

export function parseShorthand(input) {
  const filters = [];
  const texts = [];
  const tokens = String(input || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  for (const tok of tokens) {
    let t = tok.replace(/"/g, '');

    // @source
    if (t.startsWith('@')) { filters.push({ field: 'sourceUsernames', op: 'containsAll', value: [t.slice(1)] }); continue; }
    // !exclude bio word
    if (t.startsWith('!')) { filters.push({ field: 'bio', op: 'notContains', value: t.slice(1) }); continue; }

    // field>value / field>=value / field<value
    let m = t.match(/^([a-z]+)\s*(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)$/i);
    if (m && NUM_FIELDS[m[1].toLowerCase()]) {
      const field = NUM_FIELDS[m[1].toLowerCase()];
      const op = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '=': 'eq' }[m[2]];
      filters.push({ field, op, value: Number(m[3]) });
      continue;
    }
    // >500 followers  (operator first)
    m = t.match(/^(>=|<=|>|<)(\d+)$/);
    if (m) {
      const next = tokens[tokens.indexOf(tok) + 1]?.toLowerCase();
      const field = NUM_FIELDS[next] || 'followers';
      filters.push({ field, op: { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }[m[1]], value: Number(m[2]) });
      continue;
    }
    const flag = FLAGS[t.toLowerCase()];
    if (flag) { filters.push({ ...flag }); continue; }
    if (NUM_FIELDS[t.toLowerCase()]) continue;   // consumed as a unit above

    texts.push(t);
  }

  return { text: texts.join(' ').trim(), filters };
}
