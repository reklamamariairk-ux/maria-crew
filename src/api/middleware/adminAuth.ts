import { Request, Response, NextFunction } from 'express';
import { verifyToken, type AdminRole } from '../../services/adminAuth.service';

export { effectiveAdminSecret } from './secret';

declare module 'express-serve-static-core' {
  interface Request {
    adminUserId?: number;
    adminRole?: AdminRole;
  }
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.adminUserId = payload.uid;
  req.adminRole = payload.role;
  next();
}

/** Middleware-фабрика: пропускает только указанные роли. */
export function requireRole(...roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.adminRole || !roles.includes(req.adminRole)) {
      res.status(403).json({ error: 'Недостаточно прав' });
      return;
    }
    next();
  };
}
