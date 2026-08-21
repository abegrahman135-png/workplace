import { DB_NAME } from '../lib/constants.js';

const DB_VERSION = 1;

class ProspectDB {
  constructor() {
    this._db = null;
    this._initPromise = null;
  }
  
  async open() {
    if (this._db) return this._db;
    if (this._initPromise) return this._initPromise;
    
    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains('sessions')) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('sourceUsername', 'sourceUsername', { unique: false });
          sessions.createIndex('createdAt', 'createdAt', { unique: false });
          sessions.createIndex('status', 'status', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('prospects')) {
          const prospects = db.createObjectStore('prospects', { keyPath: 'username' });
          prospects.createIndex('status', 'status', { unique: false });
          prospects.createIndex('femaleScore', 'femaleScore', { unique: false });
          prospects.createIndex('finalScore', 'finalScore', { unique: false });
          prospects.createIndex('firstSeenAt', 'firstSeenAt', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('processedUsernames')) {
          const processedUsernames = db.createObjectStore('processedUsernames', { keyPath: 'username' });
          processedUsernames.createIndex('status', 'status', { unique: false });
          processedUsernames.createIndex('lastSeenAt', 'lastSeenAt', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('actionLog')) {
          const actionLog = db.createObjectStore('actionLog', { keyPath: 'id', autoIncrement: true });
          actionLog.createIndex('username', 'username', { unique: false });
          actionLog.createIndex('action', 'action', { unique: false });
          actionLog.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      
      request.onsuccess = (event) => {
        this._db = event.target.result;
        
        this._db.onversionchange = () => {
          this._db.close();
          this._db = null;
        };
        
        resolve(this._db);
      };
      
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
    
    return this._initPromise;
  }
  
  _getTransaction(storeNames, mode) {
    if (!this._db) throw new Error('Database not initialized');
    return this._db.transaction(storeNames, mode);
  }

  _promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Generic DB operations
  async get(storeName, key) {
    const tx = this._getTransaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    return this._promisifyRequest(store.get(key));
  }

  async put(storeName, value) {
    const tx = this._getTransaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    return this._promisifyRequest(store.put(value));
  }
  
  async add(storeName, value) {
    const tx = this._getTransaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    return this._promisifyRequest(store.add(value));
  }

  async update(storeName, key, changes) {
    const tx = this._getTransaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const data = getReq.result;
        if (!data) {
          reject(new Error(`Record not found for key: ${key}`));
          return;
        }
        const updated = { ...data, ...changes };
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async where(storeName, indexName, value) {
    const tx = this._getTransaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.getAll(IDBKeyRange.only(value));
    return this._promisifyRequest(request);
  }

  async getAll(storeName) {
    const tx = this._getTransaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    return this._promisifyRequest(store.getAll());
  }

  async bulkPut(storeName, items) {
    const tx = this._getTransaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      let completed = 0;
      let hasError = false;
      
      tx.oncomplete = () => {
        if (!hasError) resolve();
      };
      
      tx.onerror = (e) => {
        hasError = true;
        reject(e.target.error);
      };

      for (const item of items) {
        store.put(item);
      }
    });
  }

  // sessions API
  sessions = {
    get: (id) => this.get('sessions', id),
    put: (session) => this.put('sessions', session),
    update: (id, changes) => this.update('sessions', id, changes),
    where: (index, value) => this.where('sessions', index, value),
    all: () => this.getAll('sessions')
  };

  // prospects API
  prospects = {
    get: (username) => this.get('prospects', username),
    put: (prospect) => this.put('prospects', prospect),
    update: (username, changes) => this.update('prospects', username, changes),
    where: (index, value) => this.where('prospects', index, value),
    getAll: () => this.getAll('prospects'),
    bulkPut: (array) => this.bulkPut('prospects', array)
  };

  // processedUsernames API
  processedUsernames = {
    get: (username) => this.get('processedUsernames', username),
    put: (entry) => this.put('processedUsernames', entry),
    has: async (username) => {
      const result = await this.get('processedUsernames', username);
      return !!result;
    }
  };

  // actionLog API
  actionLog = {
    add: (entry) => this.add('actionLog', entry),
    update: (id, changes) => this.update('actionLog', id, changes)
  };

  // settings API
  settings = {
    get: (key) => this.get('settings', key),
    put: (entry) => this.put('settings', entry),
    all: () => this.getAll('settings')
  };
}

export const db = new ProspectDB();
