export class ActionQueue {
  constructor(db, dailyCap = 100) {
    this.db = db;
    this.dailyCap = dailyCap;
    this.queue = [];
    this.isRunning = false;
    this.actionsToday = 0;
  }
  
  async enqueue(action) {
    if (this.actionsToday >= this.dailyCap) {
      console.warn("Daily action cap reached");
      return false;
    }
    this.queue.push(action);
    if (this.db.actionLogs) {
      await this.db.actionLogs.add({ ...action, queuedAt: Date.now(), status: 'queued' });
    }
    return true;
  }
  
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.processNext();
  }
  
  stop() {
    this.isRunning = false;
  }
  
  async processNext() {
    if (!this.isRunning || this.queue.length === 0) {
      this.isRunning = false;
      return;
    }
    
    const action = this.queue.shift();
    const delay = Math.floor(Math.random() * (5000 - 2000 + 1) + 2000); 
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (action.type === 'OPEN_PROFILE') {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
           chrome.tabs.create({ url: `https://instagram.com/${action.payload.username}`, active: false });
        }
      }
      this.actionsToday++;
    } catch (e) {
      console.error("Action failed", e);
    }
    
    this.processNext();
  }
}
