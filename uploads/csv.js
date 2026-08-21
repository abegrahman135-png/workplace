/**
 * Generates and downloads a CSV file.
 * @param {Array} prospects Array of prospect objects
 * @param {string} filename Name of the downloaded file
 */
export function downloadCsv(prospects, filename = 'prospects.csv') {
  if (!prospects || prospects.length === 0) {
    alert("No prospects to export.");
    return;
  }

  const columns = [
    'Username',
    'Full Name',
    'Female Score',
    'Female Confidence',
    'Priority Score',
    'Priority Label',
    'Posts',
    'Followers',
    'Following',
    'Private',
    'Verified',
    'Account Type',
    'Activity Level',
    'Bio',
    'Is Mutual',
    'Source Profiles',
    'First Seen',
    'Last Seen',
    'Status',
    'Signals',
    'Enrichment Status',
    'Classification Confidence'
  ];

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '';
    const stringified = String(str);
    if (stringified.includes(',') || stringified.includes('"') || stringified.includes('\n')) {
      return `"${stringified.replace(/"/g, '""')}"`;
    }
    return stringified;
  };

  const rows = prospects.map(p => {
    return [
      p.username,
      p.fullName,
      p.classification?.femaleScore || 0,
      p.classification?.confidence || 0,
      p.priorityScore || 0,
      p.priorityLabel || 'Unknown',
      p.stats?.posts || 0,
      p.stats?.followers || 0,
      p.stats?.following || 0,
      p.isPrivate ? 'Yes' : 'No',
      p.isVerified ? 'Yes' : 'No',
      p.accountType || 'unknown',
      p.activityLevel || 'unknown',
      p.bio ? p.bio.replace(/\n/g, ' ') : '',
      p.isMutual ? 'Yes' : 'No',
      (p.sourceProfiles || []).join(';'),
      p.firstSeen ? new Date(p.firstSeen).toISOString() : '',
      p.lastSeen ? new Date(p.lastSeen).toISOString() : '',
      p.status || 'new',
      (p.signals || []).slice(0, 2).map(s => s.type).join(';'),
      p.enrichmentStatus || 'none',
      p.classification?.confidence || 0
    ].map(escapeCsv).join(',');
  });

  const csvContent = [columns.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
