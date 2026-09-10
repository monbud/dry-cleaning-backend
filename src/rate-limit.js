import { rateLimit } from 'express-rate-limit';

export function createRateLimiter(options) {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...options,
    // Express req.ip uses X-Forwarded-For with our configured proxy boundary.
    // Ignore RFC Forwarded; keep all other checks and the default IPv6 handling.
    validate: { forwardedHeader: false },
  });
}
