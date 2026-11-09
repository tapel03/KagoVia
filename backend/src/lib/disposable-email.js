// Blocks throwaway ("temporary" / "10-minute") email addresses.
// The list (8,000+ domains) comes from the community-maintained disposable-email-domains project via the
// disposable-email-domains-js package: run `npm update disposable-email-domains-js` regularly to refresh it.
// It is loaded ONCE into a Set (the package rebuilds it on every call) and parent domains are checked too,
// so "abc.mailinator.com" is caught as well as "mailinator.com".
//
// Limits, honestly: a blocklist only knows domains that have been reported. A brand-new throwaway domain,
// or a real Gmail address created by a bot, will pass. Email confirmation (Supabase) and rate limits are the
// other layers that stop those.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = new Set(require('disposable-email-domains-js/dist/dict/disposable_email_blocklist.json'));

export function createDisposableChecker({ extraDomains = [], allowDomains = [] } = {}) {
  const blocked = new Set([...BASE, ...extraDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)]);
  const allowed = new Set(allowDomains.map((d) => d.trim().toLowerCase()).filter(Boolean));

  function isDisposableDomain(domain) {
    const parts = String(domain || '').trim().toLowerCase().replace(/\.$/, '').split('.');
    // Check "a.b.mailinator.com", "b.mailinator.com", "mailinator.com" (stop before the bare TLD).
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (allowed.has(candidate)) return false;
      if (blocked.has(candidate)) return true;
    }
    return false;
  }

  return {
    size: blocked.size,
    isDisposableDomain,
    isDisposableEmail(email) {
      const at = String(email || '').lastIndexOf('@');
      return at > 0 && isDisposableDomain(String(email).slice(at + 1));
    },
  };
}

export const DISPOSABLE_EMAIL_MESSAGE =
  'Please use a permanent email address. Temporary or disposable email addresses are not accepted.';
