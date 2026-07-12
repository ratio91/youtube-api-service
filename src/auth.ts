import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { config } from './config';

// Compare SHA-256 digests so inputs of different lengths never throw
// and comparison time does not depend on the secret's content.
function safeCompare(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function basicAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="YouTube Service"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  const usernameOk = safeCompare(username ?? '', config.BASIC_AUTH_USER);
  const passwordOk = safeCompare(password ?? '', config.BASIC_AUTH_PASS);

  if (usernameOk && passwordOk) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="YouTube Service"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
}
