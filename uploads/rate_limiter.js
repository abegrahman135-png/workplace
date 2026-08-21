import { delay } from './utils.js';

export class AdaptiveRateLimiter {
  constructor({ baseDelayMs, maxDelayMs, perMinuteCap = 20 }) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.perMinuteCap = perMinuteCap;
    this.currentDelay = baseDelayMs;
    this.consecutiveErrors = 0;
    this.requestsThisMinute = 0;
    this.minuteWindowStart = Date.now();
  }

  async waitForSlot() {
    const now = Date.now();
    if (now - this.minuteWindowStart > 60000) {
      this.minuteWindowStart = now;
      this.requestsThisMinute = 0;
    }

    if (this.requestsThisMinute >= this.perMinuteCap) {
      const waitTime = 60000 - (now - this.minuteWindowStart);
      if (waitTime > 0) {
        await delay(waitTime);
        this.minuteWindowStart = Date.now();
        this.requestsThisMinute = 0;
      }
    }

    this.requestsThisMinute++;
    
    // Add ±30% jitter to current delay
    const finalDelay = this.currentDelay * (0.7 + Math.random() * 0.6);
    
    await delay(finalDelay);
  }

  reportSuccess() {
    this.consecutiveErrors = 0;
    this.currentDelay = Math.max(this.baseDelayMs, this.currentDelay * 0.9);
  }

  reportError(statusCode) {
    this.consecutiveErrors++;
    if (statusCode === 429) {
      this.currentDelay = Math.min(this.maxDelayMs, this.currentDelay * Math.pow(2, this.consecutiveErrors));
    } else if (statusCode === 401 || statusCode === 403) {
      this.currentDelay = this.maxDelayMs;
    }
  }

  reportCheckpointDetected() {
    this.currentDelay = this.maxDelayMs * 5;
  }

  getStatus() {
    return {
      currentDelay: this.currentDelay,
      consecutiveErrors: this.consecutiveErrors,
      requestsThisMinute: this.requestsThisMinute
    };
  }
}
