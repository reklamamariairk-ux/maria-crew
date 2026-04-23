import { Context, SessionFlavor } from 'grammy';
import type { Employee } from '../types';

export interface SessionData {
  step: 'idle' | 'waiting_name' | 'selecting_store';
  pendingName?: string;
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    employee?: Employee;
  };
