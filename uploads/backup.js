/**
 * Downloads a backup of current data.
 * @param {Array} sessions
 * @param {Array} prospects
 */
export function downloadBackup(sessions, prospects) {
  const backup = {
    version: 2,
    timestamp: Date.now(),
    date: new Date().toISOString(),
    sessions: sessions || [],
    prospects: prospects || []
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  
  const filename = `prospect_finder_backup_${new Date().toISOString().slice(0,10)}.json`;
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Adds an entry to the history state.
 * @param {Object} state Current state object containing history array
 * @param {string} type 'import', 'export', 'dig', etc.
 * @param {string} message Summary message
 * @param {Object} details Additional data
 * @returns {Array} Updated history array
 */
export function addHistory(state, type, message, details = {}) {
  const history = state.history || [];
  history.unshift({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type,
    message,
    details
  });
  
  // Keep only last 100 entries
  if (history.length > 100) {
    history.length = 100;
  }
  
  return history;
}
