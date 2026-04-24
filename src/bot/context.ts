import { Context, SessionFlavor } from 'grammy';
import type { Employee } from '../types';

export interface SessionData {
  step: 'idle';
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    employee?: Employee;
  };
