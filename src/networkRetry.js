export const NETWORK_ERRORS = new Set(['EAI_AGAIN','ENOTFOUND','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','ECONNRESET']);
export function temporary(error) { return NETWORK_ERRORS.has(error?.code) || (error?.cause && temporary(error.cause)) || (error?.errors?.length && error.errors.every(temporary)); }
export function retryDelay(attempt, base = 2000, random = Math.random) { return Math.min(60000, base * 2 ** Math.min(attempt, 10) * (1 + random() * .2)); }
export async function retryNetwork(operation, { log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)), stopped = () => false } = {}) {
  let attempt = 0;
  while (!stopped()) {
    log(`Network connection attempt ${attempt + 1}`);
    try { return await operation(); } catch(error) {
      if (!temporary(error)) throw error;
      const delay = retryDelay(attempt++); log(`Temporary network error ${error.code}; retrying in ${Math.round(delay)}ms`); await sleep(delay);
    }
  }
}
