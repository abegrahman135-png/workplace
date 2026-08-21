/**
 * Parses an imported file (CSV or JSON).
 * @param {File} file 
 * @returns {Promise<Array>} Array of parsed objects
 */
export async function parseImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (event) => {
      try {
        const content = event.target.result;
        
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            resolve(parsed);
          } else if (parsed.prospects && Array.isArray(parsed.prospects)) {
            resolve(parsed.prospects);
          } else {
            reject(new Error("Invalid JSON structure. Expected array or object with 'prospects' property."));
          }
        } else if (file.name.endsWith('.csv')) {
          resolve(parseCsv(content));
        } else {
          reject(new Error("Unsupported file type. Please use .csv or .json"));
        }
      } catch (err) {
        reject(err);
      }
    };
    
    reader.onerror = () => reject(new Error("Error reading file"));
    reader.readAsText(file);
  });
}

function parseCsv(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  
  // Simple CSV parser that respects quotes
  const parseLine = (line) => {
    const result = [];
    let startValueBndry = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        inQuotes = !inQuotes;
      } else if (line[i] === ',' && !inQuotes) {
        let val = line.substring(startValueBndry, i);
        result.push(val.replace(/^"|"$/g, '').replace(/""/g, '"'));
        startValueBndry = i + 1;
      }
    }
    let val = line.substring(startValueBndry);
    result.push(val.replace(/^"|"$/g, '').replace(/""/g, '"'));
    return result;
  };
  
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().trim());
  
  return lines.slice(1).map(line => {
    const values = parseLine(line);
    const obj = {};
    headers.forEach((header, index) => {
      let val = values[index];
      if (val === undefined) return;
      
      // Map to internal fields
      if (header.includes('username')) obj.username = val;
      else if (header.includes('full name')) obj.fullName = val;
      else if (header.includes('female score')) {
        obj.classification = obj.classification || {};
        obj.classification.femaleScore = parseFloat(val);
      }
      else if (header.includes('posts')) {
        obj.stats = obj.stats || {};
        obj.stats.posts = parseInt(val, 10);
      }
      else if (header.includes('followers')) {
        obj.stats = obj.stats || {};
        obj.stats.followers = parseInt(val, 10);
      }
      else if (header.includes('following')) {
        obj.stats = obj.stats || {};
        obj.stats.following = parseInt(val, 10);
      }
      else if (header.includes('bio')) obj.bio = val;
      else if (header.includes('private')) obj.isPrivate = val.toLowerCase() === 'yes';
      else if (header.includes('verified')) obj.isVerified = val.toLowerCase() === 'yes';
      else if (header.includes('status')) obj.status = val;
    });
    return obj;
  }).filter(p => p.username);
}

/**
 * Merges imported records with existing.
 * @param {Array} existing 
 * @param {Array} imported 
 * @returns {Array} Merged array
 */
export function mergeImportedRecords(existing, imported) {
  const existingMap = new Map(existing.map(p => [p.username, p]));
  
  imported.forEach(p => {
    if (!p.username) return;
    
    if (existingMap.has(p.username)) {
      const current = existingMap.get(p.username);
      // Merge strategy: imported overwrites or augments existing
      const merged = { ...current, ...p };
      
      // Deep merge nested objects
      if (current.stats && p.stats) merged.stats = { ...current.stats, ...p.stats };
      if (current.classification && p.classification) merged.classification = { ...current.classification, ...p.classification };
      
      // Merge source profiles
      if (p.sourceProfiles) {
        merged.sourceProfiles = [...new Set([...(current.sourceProfiles || []), ...p.sourceProfiles])];
      }
      
      merged.lastSeen = Date.now();
      existingMap.set(p.username, merged);
    } else {
      p.firstSeen = p.firstSeen || Date.now();
      p.lastSeen = p.lastSeen || Date.now();
      existingMap.set(p.username, p);
    }
  });
  
  return Array.from(existingMap.values());
}
